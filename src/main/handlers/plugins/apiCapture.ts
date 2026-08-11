/**
 * [lc-421] fnOS API 请求捕获诊断插件
 * 作用：捕获飞牛影视「保存/上传」类请求（非 GET 的 /v/api/v1/item、sys/img、metadata、media），
 *       打印 method / url / body，用于逆向「详情页 Logo 回填」所需的保存端点与请求体。
 * 注意：仅记录，不修改/拦截任何请求。正常日志里会出现 [API捕获] 前缀行。
 */
import { getInstance as getInterceptor } from '../core/interceptor';
import * as log from '../../../modules/logger';

function init(): void {
    const interceptor = getInterceptor();
    interceptor.registerBeforeRequest(
        { urls: ['*://*/*'] },
        (details: any, callback: any) => {
            try {
                const method = (details.method || 'GET').toUpperCase();
                if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
                    callback({});
                    return;
                }
                const url = details.url || '';
                // 跳过静态资源
                if (/\/v\/assets\/|\.(js|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|ico|json|map)(\?|$)/i.test(url)) {
                    callback({});
                    return;
                }
                // 跳过已知的外部 API（TMDB / Bangumi / 豆瓣 / Gitee 等）
                if (/themoviedb\.org|bangumi\.tv|api\.bgm\.tv|douban\.com|gitee\.com|github\.com|wikipedia\.org|fnnas\.com|mediasvc/i.test(url)) {
                    callback({});
                    return;
                }
                const kw = (url.match(/\/(item|sys\/img|metadata|media|tag|actor|genre|upload|file|logo|poster|backdrop)\b/) || ['(其他)'])[0];
                let bodyStr = '';
                try {
                    const rb = details.requestBody;
                    if (rb) {
                        if (rb.raw && rb.raw.length) {
                            bodyStr = rb.raw.map((r: any) => {
                                const b = r.bytes;
                                if (Buffer.isBuffer(b)) return b.toString('utf8');
                                if (b instanceof ArrayBuffer) return Buffer.from(new Uint8Array(b)).toString('utf8');
                                if (b && typeof b.toString === 'function') return b.toString('utf8');
                                return String(b);
                            }).join('');
                        } else if (rb.formData) {
                            bodyStr = JSON.stringify(rb.formData);
                        } else if (rb.error) {
                            bodyStr = '[requestBody.error=' + rb.error + ']';
                        }
                    }
                } catch (e) {
                    bodyStr = '[parse err ' + String(e).substring(0, 60) + ']';
                }
                log.info('[API捕获][' + kw + '] ' + method + ' ' + url + ' | body=' + bodyStr.substring(0, 4000));
            } catch (e) {
                log.error('[API捕获] 处理异常', e);
            }
            callback({});
        },
        'api-capture'
    );
    log.info('[API捕获] 诊断拦截器已注册（仅记录非GET的 item/img/metadata/media 请求）');
}

export { init };
