import { createContext, useContext, useState, ReactNode } from 'react'
import { TOKEN_KEY } from '../api/client'
import { login as apiLogin } from '../api/portal'

interface AuthState {
  token: string | null
  login: (u: string, p: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  // 门户仅维护本地登录态（token in localStorage），身份由门户后端代理平台校验。
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))

  const login = async (username: string, password: string) => {
    const { access_token } = await apiLogin(username, password)
    localStorage.setItem(TOKEN_KEY, access_token)
    setToken(access_token)
  }

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    location.href = '/login'
  }

  return <AuthContext.Provider value={{ token, login, logout }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
