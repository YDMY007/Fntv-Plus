// preload/plugins/playChoice.ts
// 播放器选择弹窗（原生 / MPV / PotPlayer），供 playButton 与 playMaskButton 复用。
// 这样「全部剧集」等剧集页的主播放按钮也能弹出与遮罩按钮一致的选择逻辑。
import { ipcRenderer } from 'electron';
import { t } from '../core/i18n';
import logger from '../core/logger';

export type PlayButtonConfig = {
    hideOriginalPlayButton: boolean;
    defaultPlayer: 'mpv' | 'potplayer';
    potPath: string;
};

// 获取播放按钮配置（带 10s 缓存，避免频繁 IPC 往返）
let _configCache: PlayButtonConfig | null = null;
let _configCacheTime = 0;
export function getPlayButtonConfig(): Promise<PlayButtonConfig> {
    if (_configCache && Date.now() - _configCacheTime < 10000) {
        return Promise.resolve(_configCache);
    }
    return new Promise((resolve) => {
        ipcRenderer.send('get-play-button-config');

        const handler = (event: any, data: any) => {
            ipcRenderer.off('play-button-config-info', handler);
            const cfg = (data || { hideOriginalPlayButton: true, defaultPlayer: 'mpv', potPath: '' }) as PlayButtonConfig;
            _configCache = cfg; // 默认隐藏原生按钮
            _configCacheTime = Date.now();
            resolve(cfg);
        };

        ipcRenderer.once('play-button-config-info', handler);

        // 2秒后超时，使用默认值
        setTimeout(() => {
            ipcRenderer.off('play-button-config-info', handler);
            const cfg = _configCache || { hideOriginalPlayButton: true, defaultPlayer: 'mpv', potPath: '' };
            _configCache = cfg;
            _configCacheTime = Date.now();
            resolve(cfg);
        }, 2000);
    });
}

// 是否处于「全部剧集 / 选集」页面（季详情页）。该类页面的主播放按钮点击后弹出选择弹窗。
export function isSeasonPage(): boolean {
    const path = window.location.pathname || '';
    return /\/v\/tv\/season\//i.test(path);
}

// 创建播放器选择弹窗
// originalButton: 被拦截的原始播放按钮（用于「原生播放」时触发其原生点击）
// config: 当前播放按钮配置（决定显示「原生播放」与否、默认外部播放器）
// playExternal: 选择外部播放器时的回调（'mpv' / 'potplayer'）
export function createPlayModal(
    originalButton: HTMLElement,
    config: PlayButtonConfig,
    playExternal: (player: 'mpv' | 'potplayer') => void
): void {
    // 如果弹窗已存在，先移除
    const existingModal = document.getElementById('play-choice-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // 创建弹窗遮罩
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'play-choice-modal';
    modalOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.3);
        z-index: 10000;
        display: flex;
        justify-content: center;
        align-items: center;
        backdrop-filter: blur(15px);
        -webkit-backdrop-filter: blur(15px);
    `;

    // 创建弹窗内容
    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
        background: rgba(255, 255, 255, 0.1);
        border-radius: 20px;
        padding: 32px;
        min-width: 380px;
        box-shadow:
            0 8px 32px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.2),
            inset 0 -1px 0 rgba(0, 0, 0, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.18);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
    `;

    // 标题
    const title = document.createElement('h3');
    title.textContent = t('选择播放方式');
    title.style.cssText = `
        margin: 0 0 24px 0;
        font-size: 20px;
        font-weight: 600;
        text-align: center;
        color: #ffffff;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        letter-spacing: 0.5px;
    `;

    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
        display: flex;
        gap: 16px;
        justify-content: center;
        flex-wrap: wrap;
    `;

    // 原生播放按钮（仅在未隐藏原生播放按钮时显示）
    const nativePlayBtn = document.createElement('button');
    nativePlayBtn.textContent = t('原生播放');
    nativePlayBtn.style.cssText = `
        padding: 12px 24px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 12px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        color: #ffffff;
        transition: all 0.3s ease;
        min-width: 100px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    `;

    // 外部播放器按钮（默认播放器：MPV 或 PotPlayer）
    const externalPlayer: 'mpv' | 'potplayer' = config.defaultPlayer;
    const extPlayBtn = document.createElement('button');
    extPlayBtn.textContent = externalPlayer === 'potplayer' ? 'PotPlayer' : t('MPV播放');
    extPlayBtn.style.cssText = externalPlayer === 'potplayer'
        ? `
        padding: 12px 24px;
        background: rgba(255, 138, 0, 0.8);
        border: 1px solid rgba(255, 138, 0, 0.6);
        border-radius: 12px;
        color: white;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(255, 138, 0, 0.4);
        min-width: 100px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        `
        : `
        padding: 12px 24px;
        background: rgba(102, 126, 234, 0.8);
        border: 1px solid rgba(102, 126, 234, 0.6);
        border-radius: 12px;
        color: white;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.3s ease;
        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        min-width: 100px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        `;

    // 取消按钮
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('取消');
    cancelBtn.style.cssText = `
        padding: 12px 24px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 12px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.8);
        transition: all 0.3s ease;
        min-width: 100px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    `;

    // 添加悬停效果
    const addHoverEffect = (btn: HTMLButtonElement, hoverStyle: Partial<CSSStyleDeclaration>, normalStyle: Partial<CSSStyleDeclaration>) => {
        btn.addEventListener('mouseenter', () => {
            Object.assign(btn.style, hoverStyle);
        });
        btn.addEventListener('mouseleave', () => {
            Object.assign(btn.style, normalStyle);
        });
    };

    addHoverEffect(nativePlayBtn, {
        background: 'rgba(255, 255, 255, 0.25)',
        borderColor: 'rgba(255, 255, 255, 0.5)',
        transform: 'translateY(-3px)',
        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.2)'
    }, {
        background: 'rgba(255, 255, 255, 0.15)',
        borderColor: 'rgba(255, 255, 255, 0.3)',
        transform: 'translateY(0)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
    });

    addHoverEffect(extPlayBtn, {
        transform: 'translateY(-3px)'
    }, {
        transform: 'translateY(0)'
    });
    if (externalPlayer === 'potplayer') {
        (extPlayBtn.style as any).background = 'rgba(255, 138, 0, 0.8)';
        addHoverEffect(extPlayBtn, {
            background: 'rgba(255, 138, 0, 0.9)',
            boxShadow: '0 8px 25px rgba(255, 138, 0, 0.6)'
        }, {
            background: 'rgba(255, 138, 0, 0.8)',
            boxShadow: '0 4px 15px rgba(255, 138, 0, 0.4)'
        });
    } else {
        (extPlayBtn.style as any).background = 'rgba(102, 126, 234, 0.8)';
        addHoverEffect(extPlayBtn, {
            background: 'rgba(102, 126, 234, 0.9)',
            boxShadow: '0 8px 25px rgba(102, 126, 234, 0.6)'
        }, {
            background: 'rgba(102, 126, 234, 0.8)',
            boxShadow: '0 4px 15px rgba(102, 126, 234, 0.4)'
        });
    }

    addHoverEffect(cancelBtn, {
        background: 'rgba(255, 255, 255, 0.2)',
        borderColor: 'rgba(255, 255, 255, 0.4)',
        color: '#ffffff',
        transform: 'translateY(-3px)',
        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.15)'
    }, {
        background: 'rgba(255, 255, 255, 0.1)',
        borderColor: 'rgba(255, 255, 255, 0.2)',
        color: 'rgba(255, 255, 255, 0.8)',
        transform: 'translateY(0)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)'
    });

    // 原生播放：触发原始按钮的原生点击（临时标记放行，避免被拦截器再次拦截）
    nativePlayBtn.addEventListener('click', () => {
        modalOverlay.remove();
        logger.info('用户选择了原生播放');
        if (originalButton) {
            originalButton.setAttribute('data-allow-original-play', 'true');
            setTimeout(() => {
                const clickEvent = new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                });
                originalButton.dispatchEvent(clickEvent);
                setTimeout(() => {
                    originalButton.removeAttribute('data-allow-original-play');
                }, 1000);
            }, 50);
        }
    });

    // 外部播放器
    extPlayBtn.addEventListener('click', () => {
        modalOverlay.remove();
        logger.info(`用户选择了外部播放器: ${externalPlayer}`);
        playExternal(externalPlayer);
    });

    cancelBtn.addEventListener('click', () => {
        modalOverlay.remove();
    });

    // 点击遮罩关闭弹窗
    modalOverlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === modalOverlay) {
            modalOverlay.remove();
        }
    });

    // ESC键关闭弹窗
    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            modalOverlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // 组装弹窗：未隐藏原生按钮时显示「原生播放」+「外部播放器」；隐藏原生时仅显示外部播放器
    if (!config.hideOriginalPlayButton) {
        buttonContainer.appendChild(nativePlayBtn);
    }
    buttonContainer.appendChild(extPlayBtn);
    buttonContainer.appendChild(cancelBtn);

    modalContent.appendChild(title);
    modalContent.appendChild(buttonContainer);
    modalOverlay.appendChild(modalContent);

    // 添加到页面
    document.body.appendChild(modalOverlay);
}
