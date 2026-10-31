import {
  randomBytes,
  randomInt,
  createHmac,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { PNG } from 'pngjs';
import { AUTH_POLICY } from '../../domain/auth/policy.js';
import type {
  TokenCodec,
  CaptchaImage,
  PasswordHasher,
} from '../../application/auth/ports.js';
import { createPasswordHasher } from './password-hasher.js';

const GLYPHS: Record<string, readonly string[]> = {
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};
const IMAGE_POLICY = {
  width: 240,
  height: 80,
  scale: 5,
  cellWidth: 34,
  left: 20,
  top: 20,
  noisePixels: 650,
};
export interface AuthSecuritySettings {
  tokenPepper: string;
  csrfSecret: string;
}

/** 随机源替换仅能通过代码装配注入；生产入口不读取测试答案环境变量。 */
export async function createAuthSecurity(
  settings: AuthSecuritySettings,
  overrides: { answer?: () => string; passwords?: PasswordHasher } = {},
) {
  const tokens: TokenCodec = {
    credential: () => randomBytes(32).toString('base64url'),
    digest: (purpose, ...parts) =>
      createHmac('sha256', settings.tokenPepper)
        .update(JSON.stringify([purpose, ...parts]))
        .digest('hex'),
    csrf: (purpose, credential) =>
      createHmac('sha256', settings.csrfSecret)
        .update(JSON.stringify(['csrf', purpose, credential]))
        .digest('hex'),
    matches: (first, second) =>
      timingSafeEqual(
        createHash('sha256').update(first).digest(),
        createHash('sha256').update(second).digest(),
      ),
  };
  const images: CaptchaImage = {
    answer:
      overrides.answer ??
      (() =>
        Array.from(
          { length: AUTH_POLICY.captchaLength },
          () =>
            AUTH_POLICY.captchaAlphabet[
              randomInt(AUTH_POLICY.captchaAlphabet.length)
            ],
        ).join('')),
    async render(answer) {
      if (!/^[2-9]{6}$/.test(answer)) throw Error('验证码随机源输出非法');
      const image = new PNG({
        width: IMAGE_POLICY.width,
        height: IMAGE_POLICY.height,
      });
      image.data.fill(248);
      for (let index = 3; index < image.data.length; index += 4)
        image.data[index] = 255;
      const paint = (x: number, y: number, color: number) => {
        const index = (y * image.width + x) * 4;
        image.data[index] = color;
        image.data[index + 1] = color;
        image.data[index + 2] = color;
      };
      for (let dot = 0; dot < IMAGE_POLICY.noisePixels; dot++)
        paint(
          randomInt(image.width),
          randomInt(image.height),
          randomInt(100, 220),
        );
      Array.from(answer).forEach((digit, index) => {
        const left =
          IMAGE_POLICY.left + index * IMAGE_POLICY.cellWidth + randomInt(-2, 3);
        const top = IMAGE_POLICY.top + randomInt(-4, 5);
        GLYPHS[digit]?.forEach((row, y) =>
          Array.from(row).forEach((pixel, x) => {
            if (pixel !== '1') return;
            for (let dy = 0; dy < IMAGE_POLICY.scale; dy++)
              for (let dx = 0; dx < IMAGE_POLICY.scale; dx++)
                paint(
                  left + x * IMAGE_POLICY.scale + dx,
                  top + y * IMAGE_POLICY.scale + dy,
                  35,
                );
          }),
        );
      });
      return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`;
    },
  };
  return {
    tokens,
    images,
    passwords: overrides.passwords ?? (await createPasswordHasher()),
  };
}
