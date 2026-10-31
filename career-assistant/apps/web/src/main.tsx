import { PrivacyPage, TrustPage } from './workspace/privacy.js';
import { WorkspaceNav } from './workspace/shared.js';
import { FavoritesPage, ApplicationsPage } from './workspace/career.js';
import { ProfilePage } from './workspace/profile.js';
import { ChatPage } from './workspace/chat.js';
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HealthResponseSchema } from '@career/contracts';
import './style.css';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/context.js';
import { JobsPage, JobDetailPage } from './workspace/jobs.js';
import { CredentialsPage, SettingsPage } from './auth/pages.js';

function App(): ReactNode {
  const [status, setStatus] = useState('尚未检查');
  const [isChecking, setIsChecking] = useState(false);
  async function checkConnection() {
    setIsChecking(true);
    try {
      const response = await fetch('/health/ready', {
        signal: AbortSignal.timeout(5000),
      });
      const parsed = HealthResponseSchema.safeParse(await response.json());
      setStatus(
        response.ok && parsed.success && parsed.data.payload.status === 'ok'
          ? '服务连接正常'
          : '服务暂不可用，请稍后重试',
      );
    } catch {
      setStatus('服务暂不可用，请稍后重试');
    } finally {
      setIsChecking(false);
    }
  }
  return (
    <section>
      <WorkspaceNav />
      <p className="eyebrow">CAREER ASSISTANT</p>
      <h1>求职助手</h1>
      <p>浏览真实岗位、核对条件并管理求职进度。</p>
      <button disabled={isChecking} onClick={() => void checkConnection()}>
        {isChecking ? '正在检查…' : '检查服务连接'}
      </button>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <nav>
        <Link to="/jobs">浏览岗位</Link>
        <Link to="/login">登录</Link>
        <Link to="/register">注册</Link>
        <Link to="/settings">账号设置</Link>
      </nav>
    </section>
  );
}

const root = document.getElementById('root');
if (!root) throw Error('页面根节点缺失');
createRoot(root).render(
  <BrowserRouter>
    <AuthProvider>
      <main className="shell">
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/login" element={<CredentialsPage mode="login" />} />
          <Route
            path="/register"
            element={<CredentialsPage mode="register" />}
          />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/trust" element={<TrustPage />} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route
            path="/resumes"
            element={<Navigate to="/chat?resumes=open" replace />}
          />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <p>
                页面不存在，<Link to="/">返回首页</Link>
              </p>
            }
          />
        </Routes>
      </main>
    </AuthProvider>
  </BrowserRouter>,
);
