// agents/core/orchestrator.js — المنسّق الرئيسي للـ 300 وكيل
//
// يشغّل:
//   • وكيلاً واحدًا (بمعرّفه الجديد S1:T3 أو القديم A1.1 — الحل يعمل)
//   • فرقة كاملة: 5 قادة × (الرئيس + فرعيان) بالتوازي
//   • سير عمل موجات: القديمة (A1.1…) تُحوَّل تلقائيًا للمعرّفات الجديدة
// كل شيء يمر عبر ناقل الرسائل، والتقارير تُكتب في specs/agents/<runId>/.
const { AGENTS, SQUADS, WORKFLOWS, GUARDIANS, resolveAgentId, countAgents } = require('./registry');
const { executeAgent, executeWithSubs } = require('./engine');
const bus = require('./bus');

class Orchestrator {
  constructor() {
    this.runCounter = 0;
  }

  _runId(prefix = 'run') {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `${stamp}_${prefix}_${++this.runCounter}`;
  }

  // ── تشغيل وكيل واحد (+ فرعيه) ──
  async runAgent(idOrLegacy, context = {}) {
    const id = resolveAgentId(idOrLegacy);
    const agent = AGENTS[id];
    if (!agent) throw new Error(`وكيل غير معروف: ${idOrLegacy}`);

    // runId يُحترم إن جاء في السياق (سير العمل يمنحه لموحّد تقارير موجته) —
    // وإلا يُسكّ runId خاصًا بالوكيل كما كان دائمًا
    const runId = typeof context.runId === 'string' && context.runId.trim()
      ? context.runId
      : this._runId(`agent_${id.replace(/[:.]/g, '_')}`);
    const subs = (agent.subagents || []).map((sid) => AGENTS[sid]).filter(Boolean);

    console.log(`\n🔧 ${agent.icon} ${agent.nameAr} (${agent.id}) — فرقة ${agent.squad}`);
    const result = await executeWithSubs(agent, subs, { runId, context });

    const allOk = result.main.ok && result.subs.every((s) => s.ok);
    console.log(`${allOk ? '✅' : '⚠️'} اكتمل: التقرير في ${result.main.file || '(فشل قبل الكتابة)'}`);
    return { runId, agent: agent.id, ...result };
  }

  // ── تشغيل فرقة كاملة (5 قادة × 3 = 15 وكيلًا بالتوازي) ──
  async runSquad(squadId, context = {}) {
    const squad = SQUADS[squadId];
    if (!squad) throw new Error(`فرقة غير معروفة: ${squadId}`);

    const runId = typeof context.runId === 'string' && context.runId.trim()
      ? context.runId
      : this._runId(`squad_${squadId}`);
    const leaders = squad.leaders.map((id) => AGENTS[id]).filter(Boolean);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${squad.icon} فرقة ${squad.name} (${squadId}) — ${leaders.length} قادة × 3 = ${leaders.length * 3} وكلاء`);
    console.log(`📌 المهمة: ${squad.mission}`);
    console.log(`${'═'.repeat(60)}`);

    bus.publish(`squad:${squadId}`, { from: 'orchestrator', type: 'squad-start', body: { runId, mission: squad.mission } });

    const started = Date.now();
    const results = await Promise.all(
      leaders.map((leader) => {
        const subs = (leader.subagents || []).map((sid) => AGENTS[sid]).filter(Boolean);
        return executeWithSubs(leader, subs, { runId, context });
      })
    );

    const agents = results.length * 3;
    const okCount = results.filter((r) => r.main.ok && r.subs.every((s) => s.ok)).length;
    const sec = ((Date.now() - started) / 1000).toFixed(1);

    bus.publish(`squad:${squadId}`, { from: 'orchestrator', type: 'squad-done', body: { runId, ok: okCount, total: results.length } });

    console.log(`\n🏁 الفرقة اكتملت في ${sec}s — وكلاء ناجحون: ${okCount * 3}/${agents}`);
    console.log(`📁 التقارير: specs/agents/${runId}/`);
    return { runId, squad: squadId, leaders: results.length, agents, okLeaders: okCount, results };
  }

  // ── تشغيل سير عمل موجات ──
  async runWorkflow(workflowId, context = {}) {
    const workflow = WORKFLOWS[workflowId];
    if (!workflow) throw new Error(`سير عمل غير معروف: ${workflowId}`);

    // runId يُسكّ مرة واحدة هنا ويُمرَّر لكل وكيل/فرقة في الموجات (مُعزَّزًا
    // بالسياق) — كان كل وكيل يسكّ runId خاصًا به فتتشتت التقارير في مجلدات
    // specs/agents/<sub-runId>/ ويبقى مجلد سير العمل فارغًا. الآن كل التقارير
    // تذهب إلى specs/agents/<runId>/ الواحد.
    const runId = typeof context.runId === 'string' && context.runId.trim()
      ? context.runId
      : this._runId(`wf_${workflowId}`);
    // سياق موحّد لكل الموجات: يحمل runId نفسه فوق أي خصائص أخرى أرسلها المتصل
    const wfContext = { ...context, runId };
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🚀 سير العمل: ${workflow.name} (${workflowId})`);
    console.log(`${'═'.repeat(60)}`);

    const started = Date.now();
    const waveResults = [];

    for (let i = 0; i < workflow.waves.length; i++) {
      const wave = workflow.waves[i];
      console.log(`\n🌊 الموجة ${i + 1}/${workflow.waves.length}: ${wave.name}`);

      let waveResult;
      if (wave.squads) {
        // موجة فرق: تُشغَّل بالتوازي أو تسلسليًا حسب mode
        const runner = (sid) => (wave.mode === 'parallel' ? this.runSquad(sid, wfContext) : this.runSquad(sid, wfContext).then((r) => (console.log('—'), r)));
        waveResult = wave.mode === 'parallel'
          ? await Promise.allSettled(wave.agents.map(runner))
          : (await wave.agents.reduce(async (acc, sid) => [...await acc, await this.runSquad(sid, wfContext)], []));
      } else {
        // موجة وكلاء (معرّفات قديمة أو جديدة) — تُحوَّل تلقائيًا
        const ids = wave.agents.map((a) => resolveAgentId(a)).filter(Boolean);
        waveResult = wave.mode === 'parallel'
          ? await Promise.allSettled(ids.map((id) => this.runAgent(id, wfContext)))
          : (await ids.reduce(async (acc, id) => [...await acc, await this.runAgent(id, wfContext)], []));
      }
      waveResults.push(waveResult);
    }

    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🎉 اكتمل سير العمل في ${sec}s — التقارير في specs/agents/${runId}/`);
    console.log(`${'═'.repeat(60)}\n`);
    return { runId, workflow: workflowId, waves: waveResults.length, sec };
  }

  // ── عرض البنية ──
  printStructure() {
    const c = countAgents();
    console.log('\n' + '═'.repeat(60));
    console.log(`🧠 نظام الوكلاء — 100 رئيسي × 2 فرعي = ${c.total} وكيلًا في ${c.squads} فرقة`);
    console.log('═'.repeat(60));

    for (const squad of Object.values(SQUADS)) {
      console.log(`\n${squad.icon} ${squad.id}: ${squad.name}`);
      console.log(`   📌 ${squad.mission}`);
      console.log(`   🛠️  مهارات الفرقة: ${(squad.skills || []).join('، ') || '—'}`);
      for (const lid of squad.leaders) {
        const L = AGENTS[lid];
        const legacy = L.oldId ? ` (سابقًا ${L.oldId})` : '';
        console.log(`   ├── ${lid} — ${L.nameAr}${legacy}`);
        console.log(`   │     الأدوات: ${[...L.realTools, ...L.tools].slice(0, 5).join('، ')}`);
        for (const sid of L.subagents) console.log(`   │   ├── 🔹 ${AGENTS[sid].nameAr}`);
      }
    }

    console.log('\n🛡️ الحرس المتجوّلون:');
    for (const g of Object.values(GUARDIANS)) console.log(`   ${g.icon} ${g.id}: ${g.nameAr} — يراقب ${g.monitors.join('، ')}`);
  }

  printSquad(squadId) {
    const squad = SQUADS[squadId];
    if (!squad) return console.log(`❌ فرقة غير معروفة: ${squadId}`);
    console.log(`\n${squad.icon} ${squad.id}: ${squad.name}`);
    console.log(`📌 ${squad.mission}`);
    console.log(`🎯 المهارات: ${(squad.skills || []).join('، ')}`);
    for (const lid of squad.leaders) {
      const L = AGENTS[lid];
      console.log(`\n  ${lid} — ${L.nameAr}${L.oldId ? ` (سابقًا ${L.oldId})` : ''}`);
      console.log(`    أدوات حقيقية: ${L.realTools.join('، ') || '—'}`);
      console.log(`    قدرات: ${L.tools.join('، ') || '—'}`);
      console.log(`    مهارات: ${L.skills.join('، ') || '—'}`);
      for (const sid of L.subagents) console.log(`      🔹 ${sid} — ${AGENTS[sid].nameAr}`);
    }
  }
}

module.exports = { Orchestrator };
