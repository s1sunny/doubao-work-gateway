// SPDX-License-Identifier: MIT
// 扫码登录 / 手动 Cookie 接入（面板内置，不依赖本机图形浏览器）
// 依据：notes/login-flow-client.md（静态分析）+ 2026-11-19 单发只读探测
//   GET  /passport/web/get_qrcode/?next=...&<SDK 公共参数>
//        → data.{ token, qrcode(base64 PNG), qrcode_index_url, expire_time }
//   GET  /passport/web/check_qrconnect/?next=...&token=...
//        → data.status ∈ new | scanned | confirmed | refused | expired
//   confirmed 时会话由该次响应 Set-Cookie 下发（无 JSON token），据此入库。
// 说明：接口只做「取码 → 轮询 → 收 Cookie → 交给 services.importCookies」，
//       设备上下文（web_id/aid/pc_version）仍由网关的 readWebContext 从官网实时获取，
//       因此网页 Cookie 与网关调用链路不冲突。

const ORIGIN = 'https://www.doubao.com';
const NEXT = 'https://www.doubao.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const PARAMS = {
  aid: '497858',
  device_platform: 'web',
  account_sdk_source: 'web',
  passport_jssdk_version: '5.4.1',
  passport_jssdk_type: 'lite',
  is_from_ttaccountsdk: '1',
  is_native_h5: '1',
  language: 'zh',
  account_app_language: 'zh-CN',
  region: 'CN',
};
const COOKIE_DOMAIN = '.doubao.com';
const QR_TTL_MS = 180_000;
const POLL_MIN_MS = 1_500;

const fail = (status, message) => Object.assign(Error(message), {status});
const qs = obj => Object.entries(obj)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  .join('&');

// 解析 Set-Cookie → [{name,value,domain,path}]（只保留网关 normalizeSession 接受的形式）
export function cookiesFromSetCookie(list = []) {
  const rows = [];
  for (const raw of list) {
    const [pair] = String(raw).split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name || /[^\x21-\x7e]/.test(name)) continue;
    if (/[\x00-\x1f\x7f;,]/.test(value)) continue;
    if (value.length > 16384) continue;
    rows.push({name, value, domain: COOKIE_DOMAIN, path: '/'});
  }
  return rows;
}

// 手工 Cookie 文本 → [{name,value,domain,path}]
// 支持 "a=1; b=2"、多行、以及误带的 "Cookie:" 前缀。
export function cookiesFromText(text) {
  if (typeof text !== 'string' || text.length > 32000) throw fail(400, 'Cookie 内容为空或过长。');
  const body = text.replace(/^\s*cookie\s*:\s*/i, '').replace(/\r?\n/g, ';');
  const rows = [];
  for (const part of body.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const name = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(name)) continue;
    if (/[\x00-\x1f\x7f;,]/.test(value)) throw fail(400, `Cookie 值包含非法字符：${name.slice(0, 24)}`);
    if (value.length > 16384) throw fail(400, 'Cookie 值过长。');
    rows.push({name, value, domain: COOKIE_DOMAIN, path: '/'});
  }
  if (!rows.some(c => ['sessionid', 'sessionid_ss'].includes(c.name)))
    throw fail(400, 'Cookie 里没有 sessionid / sessionid_ss，请确认复制的是已登录豆包网页的完整 Cookie。');
  if (rows.length > 200) throw fail(400, 'Cookie 条目过多。');
  return rows;
}

export function createQrLogin({services, shutdown} = {}) {
  let state = null; // {token, image, expireAt, csrfCookie, lastPoll, status, message}

  const signalFor = () => {
    const timeout = AbortSignal.timeout(20_000);
    return shutdown ? AbortSignal.any([shutdown, timeout]) : timeout;
  };

  async function start() {
    if (state && Date.now() < state.expireAt && state.status !== 'expired')
      return {image: state.image, expireAt: state.expireAt, status: state.status};

    const url = `${ORIGIN}/passport/web/get_qrcode/?${qs({next: NEXT, ...PARAMS})}`;
    let response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        signal: signalFor(),
        headers: {'User-Agent': UA, Referer: 'https://www.doubao.com/', Accept: 'application/json'},
      });
    } catch {
      throw fail(502, '连接豆包官网失败，请检查网络后重试。');
    }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const payload = await response.json().catch(() => ({}));
    const data = payload?.data || {};
    if (!response.ok || Number(data.error_code) !== 0 || !data.token)
      throw fail(502, data.description || data.message || `取二维码失败（${data.error_code ?? response.status}）`);

    const image = /^data:image\//.test(String(data.qrcode))
      ? String(data.qrcode)
      : `data:image/png;base64,${String(data.qrcode || '').replace(/^data:image\/\w+;base64,/, '')}`;
    if (!image || image.length < 200) throw fail(502, '豆包未返回二维码图片。');

    const csrfCookie = setCookies
      .map(row => row.split(';')[0].trim())
      .filter(row => row.startsWith('passport_csrf_token'))
      .join('; ');
    const serverExpire = Number(data.expire_time) * 1000;
    state = {
      token: String(data.token),
      image,
      expireAt: Math.max(Number.isFinite(serverExpire) ? serverExpire : 0, Date.now() + 90_000),
      csrfCookie,
      lastPoll: 0,
      status: 'new',
      message: '等待扫码',
      startedAt: Date.now(),
    };
    return {image, expireAt: state.expireAt, status: 'new'};
  }

  async function poll() {
    if (!state) return {status: 'none', message: '没有进行中的二维码。'};
    if (state.status === 'confirmed') return {status: 'confirmed', message: state.message, account: state.account};
    if (Date.now() > state.expireAt && state.status !== 'scanned') {
      state = null;
      return {status: 'expired', message: '二维码已过期，请重新生成。'};
    }
    if (Date.now() - state.lastPoll < POLL_MIN_MS)
      return {status: state.status, message: state.message};
    state.lastPoll = Date.now();

    const url = `${ORIGIN}/passport/web/check_qrconnect/?${qs({next: NEXT, ...PARAMS, token: state.token})}`;
    let response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        signal: signalFor(),
        headers: {
          'User-Agent': UA, Referer: 'https://www.doubao.com/', Accept: 'application/json',
          ...(state.csrfCookie ? {Cookie: state.csrfCookie} : {}),
        },
      });
    } catch {
      return {status: state.status, message: '网络波动，正在重试…'};
    }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const payload = await response.json().catch(() => ({}));
    const data = payload?.data || {};
    if (Number(data.error_code) === 2156) {
      state.expireAt = Math.max(state.expireAt, Date.now() + 120_000);
      return {status: state.status, message: '上游限频，稍候自动继续…'};
    }

    const map = {1: 'new', 2: 'scanned', 3: 'confirmed', 4: 'expired'};
    let scan = map[data.status] || String(data.status || '');
    if (data.redirect_url && scan !== 'expired') scan = 'confirmed';

    if (scan === 'new' || scan === '') {
      state.status = 'new'; state.message = '等待扫码';
      return {status: 'new', message: state.message};
    }
    if (scan === 'scanned') {
      state.status = 'scanned';
      state.message = '已扫码，请在手机上确认登录';
      state.expireAt = Math.max(state.expireAt, Date.now() + 180_000);
      return {status: 'scanned', message: state.message};
    }
    if (scan === 'refused') {
      state = null;
      return {status: 'refused', message: '已在手机上取消登录，请重新生成二维码。'};
    }
    if (scan === 'expired') {
      state = null;
      return {status: 'expired', message: '二维码已过期，请重新生成。'};
    }
    if (scan !== 'confirmed') return {status: state.status, message: state.message};

    // confirmed：先收本跳 Set-Cookie，缺 sessionid 再跟一跳补 cookie（不自动跳转）
    let cookies = cookiesFromSetCookie(setCookies);
    const hasSession = list => list.some(c => ['sessionid', 'sessionid_ss'].includes(c.name));
    if (!hasSession(cookies) && data.redirect_url && /^https:\/\/(www\.)?doubao\.com\//.test(String(data.redirect_url))) {
      try {
        const hop = await fetch(String(data.redirect_url), {
          redirect: 'manual',
          signal: signalFor(),
          headers: {'User-Agent': UA, Referer: 'https://www.doubao.com/'},
        });
        const extra = typeof hop.headers.getSetCookie === 'function' ? hop.headers.getSetCookie() : [];
        cookies = cookies.concat(cookiesFromSetCookie(extra));
        await hop.body?.cancel().catch(() => {});
      } catch { /* 补跳失败时用已有 Cookie 尝试 */ }
    }
    state.status = 'confirmed';
    if (!hasSession(cookies)) {
      state = null;
      throw fail(502, '扫码已确认，但豆包没有下发登录会话，请重新扫码。');
    }
    const account = await services.importCookies({cookies, clientProfile: 'web'}, {signal: shutdown});
    state.account = account;
    state.message = account.updated ? '登录已更新，账号已刷新。' : '接入成功，账号已刷新。';
    return {status: 'confirmed', message: state.message, account};
  }

  function cancel() {
    state = null;
    return {status: 'cancelled', message: '已取消本次扫码。'};
  }

  return {
    get active() { return !!state; },
    start,
    poll,
    cancel,
    // 面板关闭或请求中断时清空，避免残留二维码状态
    dispose() { state = null; },
  };
}
