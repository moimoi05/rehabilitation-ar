import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Patients from './pages/Patients'
import PatientDetail from './pages/PatientDetail'
import Sessions from './pages/Sessions'
import Results from './pages/Results'
import Settings from './pages/Settings'
import Assessment from './pages/Assessment'
import Training from './pages/Training'
import PatientsAdmin from './pages/admin/PatientsAdmin'
import PatientProfile from './pages/admin/PatientProfile'
import QuestionnairesAdmin from './pages/admin/QuestionnairesAdmin'
import ReportsPage from './pages/reports/ReportsPage'
import WorkspacePage from './features/workspace/WorkspacePage'
import TrackingTestLab from './features/workspace/ReplayTestPage'
import TrackingBenchmarkPage from './features/workspace/TrackingBenchmarkPage'
import './styles.css'
function PatientProfileRoute() { const { patientId } = useParams(); return <PatientProfile key={patientId}/> }
const router = createBrowserRouter([{ element: <Layout />, children: [
  { index: true, element: <Dashboard /> },
  { path: 'assessment', element: <Assessment /> }, { path: 'assessment/:patientId', element: <Assessment /> },
  { path: 'training', element: <Training /> }, { path: 'training/:patientId', element: <Training /> },
  { path: 'reports', element: <ReportsPage /> }, { path: 'admin', element: <PatientsAdmin /> },
  { path: 'admin/patients/:patientId', element: <PatientProfileRoute /> },
  { path: 'admin/questionnaires', element: <QuestionnairesAdmin /> },
  { path: 'patients', element: <Patients /> },
  { path: 'patients/:id', element: <PatientDetail /> }, { path: 'sessions', element: <Sessions /> },
  { path: 'workspace', element: <WorkspacePage /> }, { path: 'tracking-lab', element: <TrackingTestLab /> },
  { path: 'tracking-benchmark', element: <TrackingBenchmarkPage /> },
  { path: 'results', element: <Results /> }, { path: 'settings', element: <Settings /> },
  { path: '*', element: <div className="state">Không tìm thấy trang.</div> },
] }])
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
