/**
 * FNOS Authx 签名生成插件
 * 在主进程生成 Authx 签名（需要 Node.js crypto），
 * 通过 IPC 暴露给 preload，渲染进程自行 fetch（带 cookie 鉴权）。
 */
import { registerHandler } from '../core/ipcHandler';
import { getMd5, generateRandomDigits } from '../../../modules/fn_api/request';

const API_KEY = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const API_SECRET = '16CCEB3D-AB42-077D-36A1-F355324E4237';

function genFnAuthx(url: string, data?: any): string {
    const nonce = generateRandomDigits();
    const timestamp = Date.now();
    const dataJson = data ? JSON.stringify(data) : '';
    const dataJsonMd5 = getMd5(dataJson);
    const signStr = [API_KEY, url, nonce, timestamp.toString(), dataJsonMd5, API_SECRET].join('_');
    return `nonce=${nonce}&timestamp=${timestamp}&sign=${getMd5(signStr)}`;
}

async function handleGenAuthx(_event: any, url: string, data?: any): Promise<string> {
    return genFnAuthx(url, data);
}

function init(): void {
    registerHandler('fnos-gen-authx', handleGenAuthx, { useHandle: true });
}

export { init };
