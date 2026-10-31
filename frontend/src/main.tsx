import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Patients from './pages/Patients'
import PatientDetail from './pages/PatientDetail'
import Sessions from './pages/Sessions'
import Results from './pages/Results'
import Settings from './pages/Settings'
import WorkspacePage from './features/workspace/WorkspacePage'
import TrackingTestLab from './features/workspace/ReplayTestPage'
import './styles.css'
const router = createBrowserRouter([{ element: <Layout />, children: [
  { index: true, element: <Dashboard /> }, { path: 'patients', element: <Patients /> },
  { path: 'patients/:id', element: <PatientDetail /> }, { path: 'sessions', element: <Sessions /> },
  { path: 'workspace', element: <WorkspacePage /> }, { path: 'tracking-lab', element: <TrackingTestLab /> },
  { path: 'results', element: <Results /> }, { path: 'settings', element: <Settings /> },
  { path: '*', element: <div className="state">Không tìm thấy trang.</div> },
] }])
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
