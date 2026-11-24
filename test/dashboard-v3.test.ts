import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Capsule } from '../src/dashboard/components/Capsule';
import { RevenueSources } from '../src/dashboard/components/RevenueSources';
import type { BreakdownRow } from '../src/dashboard/lib/api';
import { OtherCurrencies, OverviewCard, type OverviewData } from '../src/dashboard/components/OverviewCard';
import { DashContext, type Dash } from '../src/dashboard/lib/context';
const context = { money: (n: number) => `GHS ${(n / 100).toFixed(2)}` } as Dash;
const render = (revenue: number, previous: number, rate = 0) => {
 const kpis = {visitors:0,sessions:0,pageviews:0,bounceRate:0,avgDuration:0,revenue,payments:0,customers:0,conversionRate:rate,revenuePerVisitor:0};
 const data = { current:kpis, previous:{...kpis,revenue:previous,conversionRate:0},series:[], range:{granularity:'day'},currency:'GHS',decimals:2 } as unknown as OverviewData;
 return renderToStaticMarkup(createElement(DashContext.Provider,{value:context},createElement(OverviewCard,{data})));
};
describe('v3 dashboard data boundaries',()=>{
 it('does not claim source shares for mixed payments and refunds',()=>{
  const rows = [{label:'Paid',revenue:1000,visitors:2,customers:1},{label:'Refund',revenue:-1500,visitors:1,customers:1}] as BreakdownRow[];
  for (const totalRevenue of [-500, 0, 2000]) {
   const html = renderToStaticMarkup(createElement(DashContext.Provider,{value:{...context,site:{id:'test'},q:{period:'30d',filters:{}}} as Dash},createElement(RevenueSources,{tab:'ref',onTab:()=>{},rows,totalRevenue})));
   expect(html).toContain('GHS 10.00');
   expect(html).toContain('GHS -15.00');
   expect(html).toContain('signed amounts; no share');
   expect(html).not.toContain('% of period revenue');
   expect(html).not.toContain('v3-meter-wrap');
   expect(html).toContain('data-row-metric="revenue" style="width:38%"');
   expect(html).toContain('data-row-metric="revenue" style="width:0%"');
  }
 });
 it('clamps decorative meters and handles nonfinite values',()=>{
  for(const ratio of [-1,0,1,2,NaN,Infinity]){
   const html=renderToStaticMarkup(createElement(Capsule,{ratio}));
   expect(html).not.toMatch(/NaN|Infinity|width:-/);
   expect((html.match(/<i>/g)||[]).length).toBe(1);
  }
 });
 it('renders zero periods without invalid numeric values',()=>{
  const html=render(0,0);expect(html).not.toMatch(/NaN|Infinity/);expect(html.match(/data-metric=/g)).toHaveLength(5);
 });
 it('keeps signed refund revenue without inventing a positive share',()=>{
  const html=render(-500,-1000);expect(html).toContain('GHS -5.00');expect(html).toContain('Signed amounts; no share');expect(html).toContain('+50.0%');
 });
 it('uses percentage points for conversion and handles new periods',()=>{
  const html=render(500,0,.07);expect(html).toContain('7.00 pts');expect(html).toContain('New');
 });
 it('omits empty foreign currency notes and formats each currency separately',()=>{
  expect(renderToStaticMarkup(createElement(OtherCurrencies,{rows:[]}))).toBe('');
  const html=renderToStaticMarkup(createElement(OtherCurrencies,{rows:[{currency:'JPY',amount:5000,payments:1},{currency:'USD',amount:8000,payments:2}]}));
  expect(html).toContain('3 payments in JPY and USD');expect(html).toContain('5,000');expect(html).toContain('80');
 });
});
