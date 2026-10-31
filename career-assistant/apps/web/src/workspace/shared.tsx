import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/context.js';
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.isLoading) return <p role="status">正在恢复登录…</p>;
  if (auth.bootstrapError)
    return (
      <div role="alert">
        {auth.bootstrapError}
        <button onClick={() => void auth.refresh()}>重试</button>
      </div>
    );
  if (!auth.user)
    return (
      <p>
        请先<Link to="/login">登录</Link>后使用。
      </p>
    );
  return <>{children}</>;
}
export function WorkspaceNav() {
  return (
    <nav aria-label="求职工作台">
      <Link to="/">首页</Link>
      <Link to="/jobs">岗位</Link>
      <Link to="/profile">我的画像</Link>
      <Link to="/chat">求职咨询</Link>
      <Link to="/favorites">收藏</Link>
      <Link to="/applications">投递进度</Link>
      <Link to="/trust">数据说明</Link>
      <Link to="/settings">账号设置</Link>
      <Link to="/privacy">隐私与数据</Link>
    </nav>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? <p role="alert">{message}</p> : null;
}
