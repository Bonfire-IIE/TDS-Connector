import type { ThemeConfig } from 'antd'

export const bonfireTheme: ThemeConfig = {
  token: {
    colorPrimary: '#d97706', colorInfo: '#c2410c', colorSuccess: '#15803d',
    colorWarning: '#b45309', colorError: '#b91c1c', colorText: '#202124',
    colorTextSecondary: '#526079', colorBorder: '#dce3ee', colorBgLayout: '#f6f8fc',
    colorBgContainer: '#ffffff', colorFillAlter: '#f8fafc',
    borderRadius: 10, borderRadiusLG: 14, boxShadowSecondary: '0 16px 40px rgba(15, 23, 42, 0.12)',
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
  components: {
    Button: { controlHeight: 36, primaryShadow: 'none', fontWeight: 600 },
    Card: { headerFontSize: 16, headerFontSizeSM: 14 },
    Menu: { itemBg: '#fbfaf8', subMenuItemBg: '#fbfaf8', itemSelectedBg: '#fff1df', itemHoverBg: '#f6f1eb', itemSelectedColor: '#9a3412', itemColor: '#5f6368', itemBorderRadius: 8 },
    Table: { headerBg: '#f8fafc', headerColor: '#526079', borderColor: '#e2e8f0' },
    Tabs: { inkBarColor: '#d97706', itemSelectedColor: '#9a3412' },
  },
}
