import { NextResponse } from 'next/server';

// 基金前十大重仓股代理
//
// 上游 fundmobapi.eastmoney.com 对来自非东方财富域名的跨域请求会直接返回
// {"ErrCode":61136403,"ErrMsg":"网络繁忙，请稍后重试！"}，浏览器端拿不到数据；
// 而 fundf10 的持仓接口在 Referer 为 localhost 时返回 404。
// 因此改由服务端代为请求（Node 侧不带 Origin/Referer，上游正常返回）。
//
// 说明：该路由依赖 Node 运行时（next dev / next start / Docker）。
// 若将来改为纯静态导出，前端会自动回退到直连，只是拿不到重仓股。

export const dynamic = 'force-dynamic';

const TTL = 6 * 60 * 60 * 1000; // 重仓股按季报披露，缓存 6 小时
const cache = new Map();

async function fetchHoldings(code) {
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0&_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`上游返回 ${res.status}`);

  const json = await res.json();
  const list = json?.Datas?.fundStocks;
  if (!Array.isArray(list)) throw new Error(json?.ErrMsg || '持仓数据为空');

  return list.slice(0, 10).map((it) => ({
    code: String(it.GPDM || ''),
    name: it.GPJC || '',
    weight: it.JZBL ? `${it.JZBL}%` : '',
  }));
}

export async function GET(request) {
  const code = new URL(request.url).searchParams.get('code') || '';
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ holdings: [], error: '基金代码不合法' }, { status: 400 });
  }

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL) {
    return NextResponse.json({ holdings: hit.value, cached: true });
  }

  try {
    const holdings = await fetchHoldings(code);
    cache.set(code, { at: Date.now(), value: holdings });
    return NextResponse.json({ holdings });
  } catch (e) {
    return NextResponse.json(
      { holdings: [], error: String(e?.message || e) },
      { status: 200 }
    );
  }
}
