import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AppDialogProvider } from './components/AppDialog.jsx'
import { installAuthFetch } from './lib/webuiAuthClient.js'
import './styles.css'

// 包装 window.fetch：自动附加 WebUI 访问密码 token（若已登录）
installAuthFetch()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppDialogProvider>
      <App />
    </AppDialogProvider>
  </React.StrictMode>
)
