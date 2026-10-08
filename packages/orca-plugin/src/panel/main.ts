import { mountPanel } from './app.js';
import { OrcaPanelBridge } from './bridge.js';

mountPanel(document.getElementById('app')!, new OrcaPanelBridge());
