/**
 * Arranque de React: monta el panel completo en #root e importa el estilo
 * global. La conexión WebSocket se crea dentro de useLab, no en este archivo.
 */
import {createRoot} from 'react-dom/client';
import ControlDashboard from './control-dashboard';
import './globals.css';

createRoot(document.getElementById('root')!).render(<ControlDashboard />);
