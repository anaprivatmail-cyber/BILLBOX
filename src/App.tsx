import './App.css'
import Login from './pages/Login'
import ProtectedHome from './pages/ProtectedHome'
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
          <Route index element={<ProtectedHome />} />
        </Route>
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
