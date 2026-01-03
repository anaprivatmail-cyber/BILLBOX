import './App.css'
import Login from './pages/Login'
import BillsPage from './features/bills/components/BillsPage'
import DashboardPage from './pages/Dashboard'
import WarrantiesPage from './features/warranties/components/WarrantiesPage'
import Reset from './pages/Reset'
import ProtectedRoute from './routes/ProtectedRoute'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import PaymentsPage from './pages/Payments'
import ReportsPage from './pages/Reports'
import Privacy from './pages/Privacy'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/app" element={<ProtectedRoute />}>
          <Route index element={<DashboardPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="bills" element={<BillsPage />} />
          <Route path="warranties" element={<WarrantiesPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
