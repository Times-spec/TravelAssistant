const fs = require('fs');
const lines = fs.readFileSync(process.env.FILE || 'summary.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const only = process.argv[2] ? process.argv[2].split(',') : null;
for (const r of lines.sort((a, b) => a.id.localeCompare(b.id))) {
  if (only && !only.includes(r.id)) continue;
  console.log(`\n## ${r.id} ${r.name} | ${r.err ? 'ERR ' + r.err.slice(0, 300) : `${r.sec}s job=${r.job} plan=${r.planStatus} 预算${r.budgetMin}min Q=${r.kernel && r.kernel.q ? r.kernel.q.before + '→' + r.kernel.q.after : '-'} 提名${r.kernel ? r.kernel.nominated : '-'}`}`);
  for (const v of r.versions || []) {
    console.log(` - ${v.title}[${v.status}] ${v.n}站 ${v.km}km 总${v.totalMin}min(停留${v.dwellMin}) 末段${v.lastLegM}m | ${v.stops.join(' > ')}`);
    const w = v.warnings.filter((x) => !/PRICE_UNKNOWN|HOURS_UNKNOWN/.test(x));
    if (w.length) console.log('   ! ' + w.join(' | '));
  }
}
