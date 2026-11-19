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
const POLL_MIN_MS = 1_500;

const fail = (status, message) => Object.assign(Error(message), {status});
const qs = obj => Object.entries(obj)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  .join('&');

// 官网页会话：先访问 /chat/ 取 ttwid 等基础 Cookie。
// 缺 ttwid 的匿名会话轮询约 6-10 次后开始返回 2156「服务繁忙」（2026-11-19 对照实验：
// 带 ttwid 连续 12 次 2s 轮询 error_code 全 0；不带则第 7 次起 2156）。
function absorbCookies(jar, response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = String(raw).split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return list;
}
const jarHeader = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

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
  let pauseUntil = 0; // 上游限频后的静默期，期间不发起轮询

  const signalFor = () => {
    const timeout = AbortSignal.timeout(20_000);
    return shutdown ? AbortSignal.any([shutdown, timeout]) : timeout;
  };

  let refreshes = 0;
  const MAX_REFRESH = 5;

  async function open() {
    if (state && Date.now() < state.expireAt && state.status !== 'expired')
      return {image: state.image, expireAt: state.expireAt, status: state.status};

    const jar = new Map();
    try {
      const page = await fetch(`${ORIGIN}/chat/`, {
        signal: signalFor(),
        headers: {'User-Agent': UA, Accept: 'text/html'},
      });
      absorbCookies(jar, page);
      await page.body?.cancel().catch(() => {});
    } catch { /* 页面会话取不到时继续，只是更容易被限频 */ }

    const url = `${ORIGIN}/passport/web/get_qrcode/?${qs({next: NEXT, ...PARAMS})}`;
    let response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        signal: signalFor(),
        headers: {'User-Agent': UA, Referer: 'https://www.doubao.com/', Accept: 'application/json',
          ...(jar.size ? {Cookie: jarHeader(jar)} : {})},
      });
    } catch {
      throw fail(502, '连接豆包官网失败，请检查网络后重试。');
    }
    absorbCookies(jar, response);
    const payload = await response.json().catch(() => ({}));
    const data = payload?.data || {};
    if (!response.ok || Number(data.error_code) !== 0 || !data.token)
      throw fail(502, data.description || data.message || `取二维码失败（${data.error_code ?? response.status}）`);

    const image = /^data:image\//.test(String(data.qrcode))
      ? String(data.qrcode)
      : `data:image/png;base64,${String(data.qrcode || '').replace(/^data:image\/\w+;base64,/, '')}`;
    if (!image || image.length < 200) throw fail(502, '豆包未返回二维码图片。');

    // SDK 轮询会带 x-tt-passport-csrf-token；缺失时上游返回 error_code=2035 非法请求
    const csrfToken = decodeURIComponent(jar.get('passport_csrf_token') || '');
    const serverExpire = Number(data.expire_time) * 1000;
    if (process.env.DW_QR_DEBUG === '1')
      console.log('[qr] start expire_in_s=', Math.round((serverExpire - Date.now()) / 1000),
        'token_suffix=', String(data.token || '').slice(-3));
    state = {
      token: String(data.token),
      image,
      // 上游 token 有效期实测 60s；到期自动换码（与官网 SDK 的 autoRefresh 一致）
      expireAt: Number.isFinite(serverExpire) && serverExpire > Date.now() ? serverExpire : Date.now() + 60_000,
      jar,
      csrfToken,
      lastPoll: 0,
      throttle: 0,
      status: 'new',
      message: '等待扫码',
      startedAt: Date.now(),
    };
    return {image, expireAt: state.expireAt, status: 'new'};
  }

  async function start() {
    refreshes = 0;
    return open();
  }

  async function autoRefresh() {
    refreshes++;
    const fresh = await open();
    return {image: fresh.image, expireAt: fresh.expireAt, status: 'refreshed',
      message: '二维码已自动刷新，请扫当前这张。', refreshes};
  }

  async function poll() {
    if (!state) return {status: 'none', message: '没有进行中的二维码。'};
    if (state.status === 'confirmed') return {status: 'confirmed', message: state.message, account: state.account};
    if (Date.now() > state.expireAt && state.status !== 'scanned') {
      state = null;
      if (refreshes < MAX_REFRESH) {
        try { return await autoRefresh(); } catch { /* 刷新失败按过期处理 */ }
      }
      return {status: 'expired', message: '二维码已过期，请重新生成。'};
    }
    if (Date.now() - state.lastPoll < POLL_MIN_MS)
      return {status: state.status, message: state.message};
    if (Date.now() < pauseUntil)
      return {status: state.status, message: '等待上游冷却…'};
    state.lastPoll = Date.now();

    const url = `${ORIGIN}/passport/web/check_qrconnect/?${qs({next: NEXT, ...PARAMS, token: state.token})}`;
    let response;
    try {
      response = await fetch(url, {
        redirect: 'error',
        signal: signalFor(),
        headers: {
          'User-Agent': UA, Referer: 'https://www.doubao.com/', Accept: 'application/json',
          ...(state.jar.size ? {Cookie: jarHeader(state.jar)} : {}),
          ...(state.csrfToken ? {'x-tt-passport-csrf-token': state.csrfToken} : {}),
        },
      });
    } catch {
      return {status: state.status, message: '网络波动，正在重试…'};
    }
    const setCookies = absorbCookies(state.jar, response);
    const payload = await response.json().catch(() => ({}));
    const data = payload?.data || {};
    // 调试：只记录状态与错误码（不含 token / cookie）
    if (process.env.DW_QR_DEBUG === '1')
      console.log('[qr]', new Date().toISOString(), 'http='+response.status, 'code='+data.error_code,
        'status='+JSON.stringify(data.status), 'has_redirect='+!!data.redirect_url,
        'desc='+String(data.description||'').slice(0,60));
    if (Number(data.error_code) === 2156) {
      state.throttle = Math.min((state.throttle || 0) + 1, 4);
      pauseUntil = Date.now() + 8_000 * state.throttle;
      state.expireAt = Math.max(state.expireAt, Date.now() + 120_000);
      return {status: state.status, message: '上游限频，稍候自动继续…', raw: {error_code: 2156}};
    }
    state.throttle = 0;
    if (Number(data.error_code) === 2035) {
      state.expireAt = Math.max(state.expireAt, Date.now() + 120_000);
      return {status: state.status, message: '二维码会话校验未通过，60 秒内可重试；持续失败请重新生成。',
        raw: {error_code: 2035}};
    }
    if (Number(data.error_code) === 2046) {
      // 扫码端 App 不被接受（官网文案要求使用「抖音 APP」扫码）
      state.status = 'error';
      state.message = '豆包返回 2046（为保证账号安全，暂不支持此操作）。请改用抖音 App 扫码，或重新生成二维码再试。';
      return {status: 'error', message: state.message, raw: {error_code: 2046}};
    }

    const map = {1: 'new', 2: 'scanned', 3: 'confirmed', 4: 'expired'};
    let scan = map[data.status] || String(data.status || '');
    if (data.redirect_url && scan !== 'expired') scan = 'confirmed';
    const raw = {status: data.status, error_code: data.error_code, has_redirect: !!data.redirect_url,
      desc: String(data.description || '').slice(0, 80)};

    if (scan === 'new' || scan === '') {
      state.status = 'new'; state.message = '等待扫码';
      return {status: 'new', message: state.message, raw};
    }
    if (scan === 'scanned') {
      state.status = 'scanned';
      state.message = '已扫码，请在手机上确认登录';
      state.expireAt = Math.max(state.expireAt, Date.now() + 180_000);
      return {status: 'scanned', message: state.message, raw};
    }
    if (scan === 'refused') {
      state = null;
      return {status: 'refused', message: '已在手机上取消登录，请重新生成二维码。'};
    }
    if (scan === 'expired') {
      state = null;
      if (refreshes < MAX_REFRESH) {
        try { return await autoRefresh(); } catch { /* 刷新失败按过期处理 */ }
      }
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
          headers: {'User-Agent': UA, Referer: 'https://www.doubao.com/',
            ...(state.jar.size ? {Cookie: jarHeader(state.jar)} : {})},
        });
        const extra = absorbCookies(state.jar, hop);
        cookies = cookies.concat(cookiesFromSetCookie(extra));
        await hop.body?.cancel().catch(() => {});
      } catch { /* 补跳失败时用已有 Cookie 尝试 */ }
    }
    // 兜底：会话 Cookie 落在 jar 里（轮询/跳转吸收过的都算）
    const jarRows = [...state.jar].map(([name, value]) => ({name, value, domain: COOKIE_DOMAIN, path: '/'}));
    cookies = cookies.concat(jarRows.filter(row => !cookies.some(c => c.name === row.name)));
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
    pauseUntil = 0;
    return {status: 'cancelled', message: '已取消本次扫码。'};
  }

  return {
    get active() { return !!state; },
    start,
    poll,
    cancel,
    // 面板关闭或请求中断时清空，避免残留二维码状态
    dispose() { state = null; pauseUntil = 0; },
  };
}
