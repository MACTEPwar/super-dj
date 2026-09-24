import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from './hooks/useAuth';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/AppShell';
import Login from './pages/Login';
import Register from './pages/Register';
import Library from './pages/Library';
import Playlists from './pages/Playlists';
import PlaylistEditor from './pages/PlaylistEditor';
import Destinations from './pages/Destinations';
import Stream from './pages/Stream';
import Templates from './pages/Templates';
import TemplateEditor from './pages/TemplateEditor';
import Donations from './pages/Donations';
import RequestPage from './pages/RequestPage';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Toaster richColors position="top-right" />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/r/:token" element={<RequestPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Navigate to="/library" replace />} />
                <Route path="/library" element={<Library />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:id" element={<PlaylistEditor />} />
                <Route path="/destinations" element={<Destinations />} />
                <Route path="/stream" element={<Stream />} />
                {/* There is one stream per account now, and no id anywhere in its URLs. Redirect the
                    three old entry points so existing bookmarks and links keep working. */}
                <Route path="/streams" element={<Navigate to="/stream" replace />} />
                <Route path="/streams/:id" element={<Navigate to="/stream" replace />} />
                <Route path="/local-stream" element={<Navigate to="/stream" replace />} />
                <Route path="/templates" element={<Templates />} />
                <Route path="/templates/:id" element={<TemplateEditor />} />
                <Route path="/donations" element={<Donations />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
