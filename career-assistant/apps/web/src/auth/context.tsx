import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { UserResponseSchema, type UserDto } from '@career/contracts';
import { authRequest, AuthApiError } from './api.js';

interface AuthState {
  user: UserDto | null;
  isLoading: boolean;
  bootstrapError: string;
  refresh: () => Promise<void>;
  setUser: (user: UserDto | null) => void;
}
const Context = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState('');
  const refresh = useCallback(async () => {
    setIsLoading(true);
    setBootstrapError('');
    try {
      setUser((await authRequest('me', UserResponseSchema)).payload);
    } catch (failure) {
      if (failure instanceof AuthApiError && failure.status === 401)
        setUser(null);
      else setBootstrapError('账号服务暂不可用，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Context.Provider
      value={{
        user,
        isLoading,
        bootstrapError,
        refresh,
        setUser: (value) => {
          setUser(value);
          setBootstrapError('');
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth(): AuthState {
  const state = useContext(Context);
  if (!state) throw Error('缺少账号上下文');
  return state;
}
