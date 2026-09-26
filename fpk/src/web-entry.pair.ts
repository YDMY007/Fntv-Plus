
import { installDiag } from './preload/web/diag';
import { runHooks, HookType } from './preload/core/hooks';
import './preload/plugins/embyWall';
import './preload/plugins/a11y';
installDiag();
function boot() { try { runHooks(HookType.OnReady); } catch (e) { console.error('boot failed', e); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
window.__FNTV_BOOT_DONE = true;
