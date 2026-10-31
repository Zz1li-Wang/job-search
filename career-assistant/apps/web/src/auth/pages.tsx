import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  CaptchaResponseSchema,
  UserResponseSchema,
  RegisterInputSchema,
  PasswordInputSchema,
  type CaptchaDto,
} from '@career/contracts';
import { authRequest, EmptyResponse, AuthApiError } from './api.js';
import { useAuth } from './context.js';

export function CredentialsPage({ mode }: { mode: 'register' | 'login' }) {
  const {
    user,
    isLoading,
    setUser,
    bootstrapError,
    refresh: refreshIdentity,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [captcha, setCaptcha] = useState<CaptchaDto | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      setCaptcha((await authRequest('captcha', CaptchaResponseSchema)).payload);
      setAnswer('');
    } catch {
      setCaptcha(null);
      setError('验证码暂时无法获取，请稍后刷新');
    } finally {
      setIsRefreshing(false);
    }
  }, []);
  useEffect(() => {
    setError('');
    setPassword('');
    setConfirmation('');
    void refresh();
  }, [mode, refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!captcha) {
      setError('请先获取验证码');
      return;
    }
    if (mode === 'register' && password !== confirmation) {
      setError('两次输入的密码不一致');
      return;
    }
    const parsed = RegisterInputSchema.safeParse({
      username,
      password,
      captchaId: captcha.captchaId,
      captchaAnswer: answer,
    });
    if (!parsed.success) {
      setError('请检查用户名、密码长度和六位验证码');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await authRequest(mode, UserResponseSchema, {
        method: 'POST',
        body: parsed.data,
        csrfToken: captcha.csrfToken,
      });
      setPassword('');
      setConfirmation('');
      if (mode === 'register')
        navigate('/login', { replace: true, state: { registered: true } });
      else {
        setUser(response.payload);
        navigate('/settings', { replace: true });
      }
    } catch (failure) {
      setError(
        failure instanceof AuthApiError
          ? failure.message
          : '服务暂不可用，请稍后重试',
      );
      await refresh();
    } finally {
      setIsSubmitting(false);
    }
  }
  if (isLoading) return <p role="status">正在读取账号…</p>;
  if (bootstrapError)
    return (
      <section>
        <p role="alert">{bootstrapError}</p>
        <button onClick={() => void refreshIdentity()}>重试</button>
      </section>
    );
  if (user) return <Navigate to="/settings" replace />;
  return (
    <section>
      <p className="eyebrow">CAREER ASSISTANT</p>
      <h1>{mode === 'register' ? '创建账号' : '登录账号'}</h1>
      {mode === 'login' && location.state?.registered && (
        <p role="status">注册成功，请登录</p>
      )}
      <p>使用用户名和密码，不需要邮箱或手机号。</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <small>3—32位字母、数字或下划线，大小写视为同一用户名。</small>
        <label>
          密码
          <input
            type="password"
            autoComplete={
              mode === 'register' ? 'new-password' : 'current-password'
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <small>12—128个字符，不会自动去除空格。</small>
        {mode === 'register' && (
          <label>
            确认密码
            <input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
          </label>
        )}
        <div className="captcha">
          {captcha && (
            <img
              src={captcha.imageDataUrl}
              alt="图片验证码"
              width={240}
              height={80}
            />
          )}
          <button
            type="button"
            className="secondary"
            disabled={isRefreshing || isSubmitting}
            onClick={() => void refresh()}
          >
            刷新验证码
          </button>
        </div>
        <label>
          验证码
          <input
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={isSubmitting || isRefreshing || !captcha}>
          {isSubmitting ? '正在提交…' : mode === 'register' ? '注册' : '登录'}
        </button>
      </form>
      <p>
        {mode === 'register' ? (
          <Link to="/login">已有账号，去登录</Link>
        ) : (
          <Link to="/register">没有账号，去注册</Link>
        )}
      </p>
      <Link to="/">返回首页</Link>
    </section>
  );
}

export function SettingsPage() {
  const {
    user,
    isLoading,
    setUser,
    bootstrapError,
    refresh: refreshIdentity,
  } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  async function change(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    const input = PasswordInputSchema.safeParse({
      currentPassword,
      newPassword,
    });
    if (!input.success) {
      setError('密码需为12—128个字符');
      return;
    }
    setIsSubmitting(true);
    setError('');
    try {
      await authRequest('password', EmptyResponse, {
        method: 'PUT',
        body: input.data,
        csrfToken: user.csrfToken,
      });
      setUser(null);
      navigate('/login', { replace: true });
    } catch (failure) {
      if (
        failure instanceof AuthApiError &&
        ['AUTH_UNAUTHENTICATED', 'AUTH_VERSION_CONFLICT'].includes(failure.code)
      ) {
        setUser(null);
        navigate('/login', { replace: true });
      } else
        setError(
          failure instanceof AuthApiError
            ? failure.message
            : '服务暂不可用，请稍后重试',
        );
    } finally {
      setCurrentPassword('');
      setNewPassword('');
      setIsSubmitting(false);
    }
  }
  async function logout() {
    if (!user) return;
    setIsSubmitting(true);
    setError('');
    try {
      await authRequest('logout', EmptyResponse, {
        method: 'POST',
        csrfToken: user.csrfToken,
      });
      setUser(null);
      navigate('/login', { replace: true });
    } catch (failure) {
      setError(
        failure instanceof AuthApiError
          ? failure.message
          : '服务暂不可用，请稍后重试',
      );
    } finally {
      setIsSubmitting(false);
    }
  }
  if (isLoading) return <p role="status">正在读取账号…</p>;
  if (bootstrapError)
    return (
      <section>
        <p role="alert">{bootstrapError}</p>
        <button onClick={() => void refreshIdentity()}>重试</button>
      </section>
    );
  if (!user) return <Navigate to="/login" replace />;
  return (
    <section>
      <p className="eyebrow">ACCOUNT</p>
      <h1>账号设置</h1>
      <nav>
        <Link to="/jobs">求职工作台</Link>
        <Link to="/privacy">隐私与数据删除</Link>
      </nav>
      <p>
        当前账号：<strong>{user.username}</strong>
      </p>
      <h2>修改密码</h2>
      <p>修改成功后，所有设备都需要重新登录。</p>
      <form onSubmit={(event) => void change(event)}>
        <label>
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={isSubmitting}>修改密码</button>
      </form>
      <button
        className="secondary"
        disabled={isSubmitting}
        onClick={() => void logout()}
      >
        退出登录
      </button>
      <p>
        <Link to="/">返回首页</Link>
      </p>
    </section>
  );
}
