import type { ThemeConfig } from 'antd'

export const bonfireTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb', colorInfo: '#2563eb', colorSuccess: '#2563eb',
    colorWarning: '#ca8a04', colorError: '#dc2626', colorText: '#172033',
    colorTextSecondary: '#667085', colorBorder: '#e3e7ee', colorBgLayout: '#f4f6f8',
    borderRadius: 8, borderRadiusLG: 12, boxShadowSecondary: '0 12px 32px rgba(15, 23, 42, 0.10)',
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
  components: {
    Button: { controlHeight: 36, primaryShadow: 'none', fontWeight: 600 },
    Card: { headerFontSize: 16, headerFontSizeSM: 14 },
    Menu: { darkItemBg: '#10182b', darkSubMenuItemBg: '#10182b', darkItemSelectedBg: '#283654', darkItemHoverBg: '#1d2942', itemBorderRadius: 8 },
    Table: { headerBg: '#f7f8fa', headerColor: '#475467', borderColor: '#e7eaf0' },
    Tabs: { inkBarColor: '#2563eb', itemSelectedColor: '#1d4ed8' },
  },
}
