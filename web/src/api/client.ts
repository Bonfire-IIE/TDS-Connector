import axios from 'axios'

export const TOKEN_KEY = 'bonfire_portal_token'

// 门户后端地址：默认走**相对路径**（空 base）——
//   dev 下由 vite proxy 把 /portal 转发到 server（见 vite.config.ts）；
//   正式单制品下前端由 server 同源托管，/portal 直达同一端口。
//   如需指向绝对后端地址可用 VITE_PORTAL_API 覆盖。
const baseURL = import.meta.env.VITE_PORTAL_API ?? ''

// 统一 API 客户端。门户后端统一响应 {code, message, data}，响应拦截解包为 data。
export const api = axios.create({
  baseURL,
  timeout: 15000,
})

// 请求拦截：附带 Bearer 令牌
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 响应拦截：解包 {code,message,data} -> data；401 -> 清除令牌并跳转登录
api.interceptors.response.use(
  (resp) => resp.data?.data,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
      if (location.pathname !== '/login') location.href = '/login'
    }
    return Promise.reject(error)
  },
)

export interface ApiResp<T> {
  code: number
  message: string
  data: T
}
