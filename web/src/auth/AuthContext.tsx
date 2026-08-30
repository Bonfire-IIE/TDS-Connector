import { createContext, useContext, useState, ReactNode } from 'react'
import { TOKEN_KEY } from '../api/client'
import { login as apiLogin } from '../api/portal'

interface AuthState {
  token: string | null
  login: (u: string, p: string) => Promise<{ switched: boolean }>
  logout: () => void
}

const AuthContext = createContext<AuthState>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  // 标签页级会话：关闭标签页即清除，避免令牌长期驻留 localStorage。
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY))

  const login = async (username: string, password: string) => {
    const { access_token, switched } = await apiLogin(username, password)
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.setItem(TOKEN_KEY, access_token)
    setToken(access_token)
    return { switched }
  }

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(TOKEN_KEY)
    setToken(null)
    location.href = '/login'
  }

  return <AuthContext.Provider value={{ token, login, logout }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
