import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './runtime.css'
import { router } from './app/router'

const app = createApp(App).use(router)
void router.isReady().then(() => app.mount('#app'))
