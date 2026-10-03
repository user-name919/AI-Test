import { createRouter, createWebHashHistory } from 'vue-router'
import WorkspaceShell from './WorkspaceShell.vue'
import NotFoundPage from './NotFoundPage.vue'
import CaseDesignPage from '../features/case-design/CaseDesignPage.vue'
import ExecutionJobsPage from '../features/executions/ExecutionJobsPage.vue'
import ExecutionReportsPage from '../features/executions/ExecutionReportsPage.vue'
import RegressionPage from '../features/regressions/RegressionPage.vue'
import EnvironmentsPage from '../features/projects/EnvironmentsPage.vue'
import ProjectsPage from '../features/projects/ProjectsPage.vue'
import TestFixturesPage from '../features/projects/TestFixturesPage.vue'

export const router = createRouter({
  // Hash 模式保留现有 Vite/静态托管，无需额外部署服务端回退规则。
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/versions' },
    { path: '/versions', name: 'version', component: WorkspaceShell },
    { path: '/requirements', name: 'requirements', component: WorkspaceShell },
    { path: '/requirements/:id', name: 'requirement-detail', meta: { workspace: 'version' }, component: WorkspaceShell },
    { path: '/cases', name: 'cases', component: WorkspaceShell },
    { path: '/case-designs/:id?', name: 'case-designs', component: CaseDesignPage },
    { path: '/executions/:id?', name: 'executions', component: ExecutionReportsPage },
    { path: '/execution-jobs/:id?', name: 'execution-jobs', component: ExecutionJobsPage },
    { path: '/regressions/:id?', name: 'regressions', component: RegressionPage },
    { path: '/environments', name: 'environments', component: EnvironmentsPage },
    { path: '/test-fixtures', name: 'test-fixtures', component: TestFixturesPage },
    { path: '/projects/:id?', name: 'projects', component: ProjectsPage },
    { path: '/memory', name: 'memory', component: WorkspaceShell },
    { path: '/:pathMatch(.*)*', component: NotFoundPage },
  ],
})
