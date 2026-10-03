import { createRouter, createWebHashHistory } from 'vue-router'
import WorkspaceShell from './WorkspaceShell.vue'
import NotFoundPage from './NotFoundPage.vue'

export const router = createRouter({
  // Hash 模式保留现有 Vite/静态托管，无需额外部署服务端回退规则。
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/versions' },
    { path: '/versions', name: 'version', component: WorkspaceShell },
    { path: '/requirements', name: 'requirements', component: WorkspaceShell },
    { path: '/cases', name: 'cases', component: WorkspaceShell },
    { path: '/executions/:id?', name: 'executions', component: WorkspaceShell },
    { path: '/memory', name: 'memory', component: WorkspaceShell },
    { path: '/:pathMatch(.*)*', component: NotFoundPage },
  ],
})
