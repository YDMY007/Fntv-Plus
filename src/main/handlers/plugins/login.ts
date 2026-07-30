import * as path from 'path';
import { OnBeforeRequestListenerDetails } from 'electron';
import { getInstance as getInterceptor } from '../core/interceptor';
import { readConfig, saveConfig } from '../../../modules/fn_config/config';
import { getMainWindow } from '../../common/mainwin';
import { session } from 'electron';
import * as log from '../../../modules/logger';

/**
 * 登录拦截插件
 * 处理登录和登出请求的拦截
 */

/**
 * 清空登录信息和Cookie
 */
function clearLoginCookies(keepToken: boolean = false): void {
    log.info('清空登录信息和Cookie');

    // 清空配置中保存的token
    const config = readConfig() || {};
    if (config.token || config.domain) {
        // 保留domain和useHttps但清空token
        saveConfig({
            account: config.account || '',
            domain: config.domain || '',
            token: keepToken ? (config.token || '') : '',
            useHttps: config.useHttps
        });
        log.info(keepToken ? '已保留 token(仅清空会话 cookie)' : '已清空配置中的登录token');
    }

    // 清除会话中的cookie
    const ses = session.fromPartition('persist:fntv');
    ses.clearStorageData({
        storages: ['cookies']
    }).then(() => {
        log.info('会话Cookie已清除');
    }).catch(err => {
        log.error('清除Cookie失败:', err);
    });
}

/**
 * 处理登录请求拦截
 * @param details - 请求详情
 * @param callback - 回调函数
 */
function handleLoginRequest(details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void): void {
    log.info('检测到登录请求，清空登录信息并跳转到登录页面');

    // FN ID 会话: 访问 /v/login 通常是会话过期, 保留 token 避免 FN ID 标记被清空
    // (否则每次重启会话失效都会把 token 清空, 导致 FN ID 永远无法自动恢复, 反复要求重登)
    const _cfg = readConfig() || {};
    const _keepToken = _cfg.loginType === 'fnid' && !!_cfg.token;
    // 清空配置cookie
    clearLoginCookies(_keepToken);
    
    // 取消请求
    callback({ cancel: true });
    
    // 加载自定义页面
    const mainWindow = getMainWindow();
    if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '../../../../resource/login/index.html'));
    } else {
        log.error('主窗口未创建，无法跳转到登录页面');
    }
}

/**
 * 处理登出请求拦截
 * @param details - 请求详情
 * @param callback - 回调函数
 */
function handleLogoutRequest(details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void): void {
    log.info('检测到登出请求，清空登录信息并跳转到登录页面');
    
    // 清空配置cookie
    clearLoginCookies();
    
    // 取消请求
    callback({ cancel: true });
    
    // 加载自定义页面
    const mainWindow = getMainWindow();
    if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '../../../../resource/login/index.html'));
    } else {
        log.error('主窗口未创建，无法跳转到登录页面');
    }
}

/**
 * 初始化登录拦截插件
 */
function init(): void {
    const interceptorManager = getInterceptor();

    // 注册登录请求拦截器
    // 注意：仅拦截 /v/login（真正的登录页）。
    // 不拦截 /v/welcome —— 那是 fnOS 的隐私协议/欢迎页（含防伪码验证后的流程），
    // 拦截会导致用户输入防伪码后直接跳过隐私页进桌面（lc-202 修复）。
    interceptorManager.registerBeforeRequest(
        {
            urls: [
                'http://*/v/login',
                'https://*/v/login',
            ]
        },
        handleLoginRequest,
        'login-interceptor'
    );

    // 注册登出请求拦截器
    interceptorManager.registerBeforeRequest(
        {
            urls: [
                'http://*/v/api/v1/user/logout',
                'https://*/v/api/v1/user/logout'
            ]
        },
        handleLogoutRequest,
        'logout-interceptor'
    );

    log.info('登录拦截插件已初始化');
}

export {
    init,
};
