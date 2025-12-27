import './App.css'
import Login from './pages/Login'
import BillsPage from './features/bills/components/BillsPage'
import Reset from './pages/Reset'
import ProtectedRoute from './routes/ProtectedRoute'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/app" element={<ProtectedRoute />}>
          <Route index element={<BillsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
