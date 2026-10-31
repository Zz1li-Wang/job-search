import { describe, it, expect } from 'vitest';
import {
  parseListHtml,
  parseEvidenceHtml,
  validateSourceUrl,
  isPublicAddress,
  IngestionError,
} from '@career/business';
const now = new Date('2026-10-30T10:00:00Z');
const html = (body: string) =>
  `<html><head><title>测试</title></head><body><header>账户秘密</header><main>${body}</main></body></html>`;
describe('来源解析与访问边界', () => {
  it('无岗位链接但未明确空结果时不能成功结束扫描', () => {
    expect(() =>
      parseListHtml(html('<h1>找岗位</h1><p>正在加载</p>'), 1, now),
    ).toThrow();
    expect(
      parseListHtml(html('<h1>找岗位</h1><p>暂无岗位</p>'), 1, now).jobIds,
    ).toEqual([]);
  });
  it('列表只取实际岗位链接并识别下一页，不把社招过滤掉', () => {
    const page = parseListHtml(
      html(
        '<h1>找岗位</h1><a href="/jobs/opaque_id">校招</a><a href="/jobs/social_id">社招</a><a href="/jobs?page=2&amp;sort=latest">下一页</a>',
      ),
      1,
      now,
    );
    expect(page.jobIds).toEqual(['opaque_id', 'social_id']);
    expect(page.nextPage).toBe(2);
  });
  it('来源详情单位采用明确雇主标记，不猜测相邻文本', () => {
    expect(
      parseEvidenceHtml(
        html(
          '<h1>测试岗位</h1><p class="detail-employer"><span class="detail-employer-name">测试招聘单位</span></p><p>条件以原文为准</p>',
        ),
        now,
      ).body.company,
    ).toBe('测试招聘单位');
  });
  it('HTTP200登录和会员页不能变成空列表成功', () => {
    expect(() =>
      parseListHtml(html('<h1>登录后查看第 2 页岗位</h1>'), 2, now),
    ).toThrow(IngestionError);
    expect(() => parseListHtml(html('<h1>会员专享</h1>'), 2, now)).toThrow(
      IngestionError,
    );
  });
  it('正文去除脚本表单和账户区域，保留缺失与原文链接', () => {
    const page = parseEvidenceHtml(
      html(
        '<h1>会计</h1><dl><dt>招聘类型</dt><dd>社招</dd><dt>经验要求</dt><dd>公告未写明</dd><dt>报名截止</dt><dd>2026-11-30</dd></dl><script>secretScript</script><form>secretForm</form><p>请核对完整公告</p><a href="/announcements/opaque_id?tracking=secret">公告</a><a href="https://example.org/jobs?token=secret">原文</a>',
      ),
      now,
    );
    expect(page.body.recruitmentType).toBe('social');
    expect(page.body.availability).toBe('unknown');
    expect(page.body.deadline.precision).toBe('date');
    expect(page.body.company).toBe(null);
    expect(JSON.stringify(page.body)).not.toMatch(/secret|账户秘密/);
    expect(page.body.links).toHaveLength(2);
  });
  it('限定源站origin、路径和参数，不接受内网和任意查询', () => {
    for (const url of [
      'http://www.zhidianmijin.com.cn/jobs',
      'https://127.0.0.1/jobs',
      'https://www.zhidianmijin.com.cn/account',
      'https://www.zhidianmijin.com.cn/jobs?url=http://internal',
      'https://user:pass@www.zhidianmijin.com.cn/jobs',
    ])
      expect(() => validateSourceUrl(url)).toThrow();
    expect(
      validateSourceUrl('https://www.zhidianmijin.com.cn/jobs/opaque_1')
        .pathname,
    ).toBe('/jobs/opaque_1');
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.1.2',
      '::1',
      '::ffff:192.168.1.1',
      'fc00::1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
});
