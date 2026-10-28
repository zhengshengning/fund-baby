import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Shanghai');

const TZ = 'Asia/Shanghai';
const nowInTz = () => dayjs().tz(TZ);
const toTz = (input) => (input ? dayjs.tz(input, TZ) : nowInTz());

export const loadScript = (url) => {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || !document.body) return resolve();
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const cleanup = () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('数据加载失败'));
    };
    document.body.appendChild(script);
  });
};

export const fetchFundNetValue = async (code, date) => {
  if (typeof window === 'undefined') return null;
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&sdate=${date}&edate=${date}`;
  try {
    await loadScript(url);
    if (window.apidata && window.apidata.content) {
      const content = window.apidata.content;
      if (content.includes('暂无数据')) return null;
      const rows = content.split('<tr>');
      for (const row of rows) {
        if (row.includes(`<td>${date}</td>`)) {
          const cells = row.match(/<td[^>]*>(.*?)<\/td>/g);
          if (cells && cells.length >= 2) {
            const valStr = cells[1].replace(/<[^>]+>/g, '');
            const val = parseFloat(valStr);
            return isNaN(val) ? null : val;
          }
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

export const fetchSmartFundNetValue = async (code, startDate) => {
  const today = nowInTz().startOf('day');
  let current = toTz(startDate).startOf('day');
  for (let i = 0; i < 30; i++) {
    if (current.isAfter(today)) break;
    const dateStr = current.format('YYYY-MM-DD');
    const val = await fetchFundNetValue(code, dateStr);
    if (val !== null) {
      return { date: dateStr, value: val };
    }
    current = current.add(1, 'day');
  }
  return null;
};

// ---------------------------------------------------------------------------
// 数据源说明（2026 年上游变更）
//
// 天天基金应监管要求已下线“基金实时估值”，fundgz.1234567.com.cn 现在对任意代码
// 都返回 HTML 404 页（HTTP 状态却是 200），JSONP 回调永不触发，脚本解析失败会走
// onerror。同时 fundf10 的持仓 / 历史净值接口在本地域名（Referer 为 localhost）下
// 也返回 404，只在 Referer 为 eastmoney 域名时才正常。
//
// 因此这里改用三个目前仍然可用的数据源：
//   1. qt.gtimg.cn                      单位净值、净值日期、日涨跌幅
//   2. fundmobapi.eastmoney.com         前十大重仓股（返回 JSON，带 CORS 头）
//   3. fund.eastmoney.com/pingzhongdata 历史净值走势（脚本注入全局变量）
// ---------------------------------------------------------------------------

const HOLDINGS_TTL = 6 * 60 * 60 * 1000; // 重仓股按季报披露，缓存 6 小时
const TREND_TTL = 10 * 60 * 1000;        // 净值走势按日更新，缓存 10 分钟
const dataCache = new Map();

// 估值接口探测失败后，本次会话内直接走降级，避免 30 秒轮询每次都产生失败请求。
// 保留一个重试窗口，万一上游恢复也能自动切回去。
const VALUATION_RETRY_MS = 30 * 60 * 1000;
const VALUATION_DOWN_KEY = 'fundgzDownUntil';
let valuationDownUntil = 0;

const isValuationDown = () => {
  if (valuationDownUntil > Date.now()) return true;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const saved = Number(window.sessionStorage.getItem(VALUATION_DOWN_KEY) || 0);
      if (saved > Date.now()) {
        valuationDownUntil = saved;
        return true;
      }
    }
  } catch (e) {
  }
  return false;
};

const markValuationDown = () => {
  valuationDownUntil = Date.now() + VALUATION_RETRY_MS;
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(VALUATION_DOWN_KEY, String(valuationDownUntil));
    }
  } catch (e) {
  }
};

const readCache = (key, ttl) => {
  const hit = dataCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    dataCache.delete(key);
    return null;
  }
  return hit.value;
};

const writeCache = (key, value) => {
  dataCache.set(key, { at: Date.now(), value });
  return value;
};

// 把 6 位 A 股 / 5 位港股代码转成腾讯行情符号，例如 000858 -> s_sz000858
const toTencentStockSymbol = (code) => {
  const cd = String(code || '');
  if (/^\d{6}$/.test(cd)) {
    const pfx = cd.startsWith('6') || cd.startsWith('9')
      ? 'sh'
      : ((cd.startsWith('4') || cd.startsWith('8')) ? 'bj' : 'sz');
    return `s_${pfx}${cd}`;
  }
  if (/^\d{5}$/.test(cd)) return `s_hk${cd}`;
  return null;
};

// 基金名称：搜索接口对部分基金返回空，失败时交给腾讯行情里的名称兜底
const fetchFundName = async (c) => {
  const cached = readCache(`name:${c}`, HOLDINGS_TTL);
  if (cached) return cached;
  const cb = `SuggestData_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(c)}&callback=${cb}&_=${Date.now()}`;
  let name = '';
  try {
    await new Promise((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        delete window[cb];
        res();
      };
      window[cb] = (data) => {
        if (data && Array.isArray(data.Datas)) {
          const found = data.Datas.find((d) => d.CODE === c);
          if (found) name = found.NAME || found.SHORTNAME || '';
        }
        finish();
      };
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        if (document.body.contains(script)) document.body.removeChild(script);
      };
      script.onerror = () => {
        if (document.body.contains(script)) document.body.removeChild(script);
        finish();
      };
      document.body.appendChild(script);
      setTimeout(finish, 3000);
    });
  } catch (e) {
  }
  return name ? writeCache(`name:${c}`, name) : '';
};

// 前十大重仓股
// 优先走本地代理 /api/holdings（上游拒绝浏览器跨域，服务端代为请求）；
// 代理不可用时（例如纯静态部署）再尝试直连，都失败则返回空数组。
export const fetchHoldingsByMobileApi = async (c) => {
  let base = readCache(`holdings:${c}`, HOLDINGS_TTL);
  if (!base) {
    const list = await requestHoldings(c);
    if (!Array.isArray(list) || !list.length) throw new Error('持仓数据为空');
    // 只缓存低频变化的代码/名称/占比，当日涨跌每次实时取
    base = writeCache(`holdings:${c}`, list.slice(0, 10).map((it) => ({
      code: String(it.code || ''),
      name: it.name || '',
      weight: it.weight || '',
    })));
  }

  const holdings = base.map((h) => ({ ...h, change: null }));

  // 用腾讯行情补齐重仓股当日涨跌幅
  const symbols = holdings.map((h) => toTencentStockSymbol(h.code)).filter(Boolean);
  if (symbols.length) {
    try {
      await loadScript(`https://qt.gtimg.cn/q=${symbols.join(',')}&_t=${Date.now()}`);
      holdings.forEach((h) => {
        const sym = toTencentStockSymbol(h.code);
        if (!sym) return;
        const raw = window[`v_${sym}`];
        if (typeof raw !== 'string') return;
        const parts = raw.split('~');
        if (parts.length > 5) {
          const chg = parseFloat(parts[5]);
          if (Number.isFinite(chg)) h.change = chg;
        }
      });
    } catch (e) {
    }
  }
  return holdings;
};

// 先本地代理，再直连上游，任一成功即返回
const requestHoldings = async (c) => {
  try {
    const res = await fetch(`/api/holdings?code=${encodeURIComponent(c)}`, { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json?.holdings) && json.holdings.length) return json.holdings;
    }
  } catch (e) {
  }

  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${c}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('持仓接口返回异常');
  const json = await res.json();
  const list = json?.Datas?.fundStocks;
  if (!Array.isArray(list) || !list.length) throw new Error('持仓数据为空');
  return list.map((it) => ({
    code: String(it.GPDM || ''),
    name: it.GPJC || '',
    weight: it.JZBL ? `${it.JZBL}%` : '',
  }));
};

// pingzhongdata 脚本会把结果挂到同一个全局变量上，并发加载不同基金时会互相覆盖，
// 因此用串行队列保证同一时刻只有一个走势请求在跑。
let trendQueue = Promise.resolve();
const runTrendExclusive = (task) => {
  const next = trendQueue.then(task, task);
  trendQueue = next.then(() => { }, () => { });
  return next;
};

// 历史净值走势（最近 90 个交易日）
export const fetchHistoryTrend = async (c) => {
  const cached = readCache(`trend:${c}`, TREND_TTL);
  if (cached) return cached;
  return runTrendExclusive(async () => {
    // 排队期间可能已被同基金的另一次调用填充
    const hit = readCache(`trend:${c}`, TREND_TTL);
    if (hit) return hit;

    const empty = { historyTrend: [], yesterdayChange: null };
    try {
      await loadScript(`https://fund.eastmoney.com/pingzhongdata/${c}.js?v=${Date.now()}`);
    } catch (e) {
      return empty;
    }

    const trend = Array.isArray(window.Data_netWorthTrend) ? window.Data_netWorthTrend : [];
    if (!trend.length) return empty;

    const sliced = trend.slice(-90);
    const historyTrend = sliced.map((item) => ({
      x: item.x,
      y: item.y,
      equityReturn: item.equityReturn,
    }));
    const prev = sliced[sliced.length - 2];
    const yesterdayChange = prev && typeof prev.equityReturn === 'number' ? prev.equityReturn : null;

    return writeCache(`trend:${c}`, { historyTrend, yesterdayChange });
  });
};

/**
 * 估值接口不可用时的降级实现：用已结算净值代替盘中估值。
 * 返回结果带 noValuation: true，页面会展示“净值日期”而不是“估值时间”。
 */
export const fetchFundDataFallback = async (c) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('无浏览器环境');
  }

  const fundName = await fetchFundName(c).catch(() => '');

  // 腾讯基金行情：提供单位净值、净值日期、日涨跌幅
  let quote = null;
  try {
    await loadScript(`https://qt.gtimg.cn/q=jj${c}&_t=${Date.now()}`);
    const raw = window[`v_jj${c}`];
    if (typeof raw === 'string' && raw.length > 5) {
      const p = raw.split('~');
      const dwjz = p[5];
      if (dwjz && dwjz !== '0.0000') {
        const zzl = parseFloat(p[7]);
        quote = {
          name: fundName || p[1] || `未知基金(${c})`,
          dwjz,
          zzl: Number.isFinite(zzl) ? zzl : null,
          jzrq: p[8] ? p[8].slice(0, 10) : '',
        };
      }
    }
  } catch (e) {
    quote = null;
  }

  if (!quote) {
    throw new Error('未能获取到基金数据');
  }

  const [holdings, trendData] = await Promise.all([
    fetchHoldingsByMobileApi(c).catch(() => []),
    fetchHistoryTrend(c).catch(() => ({ historyTrend: [], yesterdayChange: null })),
  ]);

  return {
    code: c,
    name: quote.name,
    dwjz: quote.dwjz,
    gsz: null,
    gztime: null,
    jzrq: quote.jzrq,
    gszzl: null,
    zzl: quote.zzl,
    noValuation: true,
    holdings,
    historyTrend: trendData.historyTrend,
    yesterdayChange: trendData.yesterdayChange,
  };
};

export const fetchFundData = async (c) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('无浏览器环境');
  }

  // 已确认估值源不可用，直接降级，不再发起必然失败的请求
  if (isValuationDown()) {
    return fetchFundDataFallback(c);
  }

  return new Promise((resolve, reject) => {
    const gzUrl = `https://fundgz.1234567.com.cn/js/${c}.js?rt=${Date.now()}`;
    const scriptGz = document.createElement('script');
    scriptGz.src = gzUrl;
    const originalJsonpgz = window.jsonpgz;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (window.jsonpgz !== originalJsonpgz) window.jsonpgz = originalJsonpgz;
      if (document.body.contains(scriptGz)) document.body.removeChild(scriptGz);
    };

    // 估值接口已下线：统一降级到腾讯净值 + 移动端持仓 + 历史走势
    const useFallback = () => {
      if (settled) return;
      settled = true;
      markValuationDown();
      cleanup();
      fetchFundDataFallback(c).then(resolve).catch(reject);
    };

    window.jsonpgz = (json) => {
      if (settled) return;
      if (!json || typeof json !== 'object') {
        useFallback();
        return;
      }
      settled = true;
      cleanup();
      const gszzlNum = Number(json.gszzl);
      const gzData = {
        code: json.fundcode,
        name: json.name,
        dwjz: json.dwjz,
        gsz: json.gsz,
        gztime: json.gztime,
        jzrq: json.jzrq,
        gszzl: Number.isFinite(gszzlNum) ? gszzlNum : json.gszzl
      };
      const tencentPromise = new Promise((resolveT) => {
        const tUrl = `https://qt.gtimg.cn/q=jj${c}`;
        const tScript = document.createElement('script');
        tScript.src = tUrl;
        tScript.onload = () => {
          const v = window[`v_jj${c}`];
          if (v) {
            const p = v.split('~');
            resolveT({
              dwjz: p[5],
              zzl: parseFloat(p[7]),
              jzrq: p[8] ? p[8].slice(0, 10) : ''
            });
          } else {
            resolveT(null);
          }
          if (document.body.contains(tScript)) document.body.removeChild(tScript);
        };
        tScript.onerror = () => {
          if (document.body.contains(tScript)) document.body.removeChild(tScript);
          resolveT(null);
        };
        document.body.appendChild(tScript);
      });
      // 估值命中时同样复用统一的数据源（重仓股走代理、走势走串行队列）
      const holdingsPromise = fetchHoldingsByMobileApi(c).catch(() => []);
      const trendPromise = fetchHistoryTrend(c).catch(() => ({ historyTrend: [], yesterdayChange: null }));

      Promise.all([tencentPromise, holdingsPromise, trendPromise]).then(([tData, holdings, trendData]) => {
        if (tData) {
          if (tData.jzrq && (!gzData.jzrq || tData.jzrq >= gzData.jzrq)) {
            gzData.dwjz = tData.dwjz;
            gzData.jzrq = tData.jzrq;
            gzData.zzl = tData.zzl;
          }
        }
        const { historyTrend, yesterdayChange } = trendData || {};
        resolve({ ...gzData, holdings, historyTrend, yesterdayChange });
      });
    };
    scriptGz.onerror = () => {
      // 上游返回 HTML 错误页时浏览器会因解析失败触发 onerror
      useFallback();
    };
    document.body.appendChild(scriptGz);
    // 兜底：脚本能加载但始终不回调 jsonpgz 的情况，超时后同样降级
    timer = setTimeout(useFallback, 6000);
  });
};

export const searchFunds = async (val) => {
  if (!val.trim()) return [];
  if (typeof window === 'undefined' || typeof document === 'undefined') return [];
  const callbackName = `SuggestData_${Date.now()}`;
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(val)}&callback=${callbackName}&_=${Date.now()}`;
  return new Promise((resolve, reject) => {
    window[callbackName] = (data) => {
      let results = [];
      if (data && data.Datas) {
        results = data.Datas.filter(d =>
          d.CATEGORY === 700 ||
          d.CATEGORY === '700' ||
          d.CATEGORYDESC === '基金'
        );
      }
      delete window[callbackName];
      resolve(results);
    };
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
    script.onerror = () => {
      if (document.body.contains(script)) document.body.removeChild(script);
      delete window[callbackName];
      reject(new Error('搜索请求失败'));
    };
    document.body.appendChild(script);
  });
};

export const fetchShanghaiIndexDate = async () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://qt.gtimg.cn/q=sh000001&_t=${Date.now()}`;
    script.onload = () => {
      const data = window.v_sh000001;
      let dateStr = null;
      if (data) {
        const parts = data.split('~');
        if (parts.length > 30) {
          dateStr = parts[30].slice(0, 8);
        }
      }
      if (document.body.contains(script)) document.body.removeChild(script);
      resolve(dateStr);
    };
    script.onerror = () => {
      if (document.body.contains(script)) document.body.removeChild(script);
      reject(new Error('指数数据加载失败'));
    };
    document.body.appendChild(script);
  });
};

export const fetchLatestRelease = async () => {
  // 暂时禁用版本检查，避免控制台 404 报错
  return null;
  /*
  try {
    const res = await fetch('https://api.github.com/repos/zhengshengning/fund-baby/releases/latest');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      tagName: data.tag_name,
      body: data.body || ''
    };
  } catch (e) {
    return null;
  }
  */
};

export const submitFeedback = async (formData) => {
  const response = await fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    body: formData
  });
  return response.json();
};

export const fetchIntradayData = async (code) => {
    try {
        // 使用腾讯财经接口，支持 CORS，无需后端代理
        const url = `https://web.ifzq.gtimg.cn/fund/newfund/fundSsgz/getSsgz?app=web&symbol=jj${code}&_=${Date.now()}`;
        const response = await fetch(url);
        if (!response.ok) return null;

        const result = await response.json();
        if (result.code === 0 && result.data && Array.isArray(result.data.data)) {
            const { data: list, yesterdayDwjz } = result.data;
            const yDwjz = parseFloat(yesterdayDwjz);

            if (!yDwjz) return null;

            return list.map(item => {
                // item: ["0930", 1.1846, -0.0036] (时间, 估值, 涨跌额)
                const timeStr = item[0];
                const value = Number(item[1]);

                // 格式化时间 "0930" -> "09:30"
                const formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2)}`;

                // 计算涨跌幅
                const growth = ((value - yDwjz) / yDwjz * 100).toFixed(2);

                return {
                    time: formattedTime,
                    value: value,
                    growth: growth
                };
            });
        }
        return null;
    } catch (e) {
        console.error('获取分时数据失败', code, e);
        return null;
    }
};
