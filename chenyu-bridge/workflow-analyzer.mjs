// 工作流自动解析：从 ComfyUI API 格式工作流里识别输出节点与常用字段映射。
// 目标是把"上传工作流 → 自动适配字段"做到可用，减少手工配置。
export function analyzeWorkflow(input) {
  let wf = input;
  if (typeof input === 'string') wf = JSON.parse(input);
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) throw new Error('工作流 JSON 必须是对象');
  const nodes = Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type);
  if (!nodes.length) throw new Error('未在工作流中发现节点（class_type）');
  const cls = (n) => String(n.class_type || '').toLowerCase();
  const title = (n) => String((n._meta && n._meta.title) || '');
  const notes = [];
  const warnings = [];

  // 输出节点
  let outputNode = '';
  let outputKind = '';
  const findOut = (re, kind) => { if (outputNode) return; for (const [id, n] of nodes) { if (re.test(cls(n))) { outputNode = id; outputKind = kind; return; } } };
  findOut(/vhs_videocombine|savevideo|saveanimated|savewebm/, 'video');
  if (!outputNode) findOut(/saveimage/, 'image');
  if (!outputNode) findOut(/save/, 'image');
  if (outputNode) notes.push(`输出节点 → ${outputNode}（${outputKind}）`);
  else warnings.push('未找到输出节点（SaveImage / VHS_VideoCombine）');

  const mapping = {};

  // 提示词：优先“提示词输入”多行文本，其次 Text，其次 CLIPTextEncode（取最长，通常是正向）
  let promptNode = '', promptInput = '';
  const setPrompt = (id, inp) => { if (!promptNode) { promptNode = id; promptInput = inp; } };
  for (const [id, n] of nodes) {
    const ins = n.inputs || {};
    if (/提示词/.test(title(n)) && !/优化/.test(cls(n)) && ('value' in ins || 'text' in ins)) setPrompt(id, 'value' in ins ? 'value' : 'text');
  }
  if (!promptNode) for (const [id, n] of nodes) { const ins = n.inputs || {}; if (cls(n) === 'text' && 'text' in ins) setPrompt(id, 'text'); }
  if (!promptNode) {
    let best = '', len = -1;
    for (const [id, n] of nodes) { const ins = n.inputs || {}; if (/cliptextencode/.test(cls(n)) && typeof ins.text === 'string' && ins.text.length > len) { len = ins.text.length; best = id; } }
    if (best) setPrompt(best, 'text');
  }
  if (!promptNode) for (const [id, n] of nodes) { const ins = n.inputs || {}; if (/promptoptimizer/.test(cls(n)) && '用户提示词' in ins) setPrompt(id, '用户提示词'); }
  if (promptNode) { mapping.prompt = { node: promptNode, input: promptInput }; notes.push(`提示词 → 节点 ${promptNode}.${promptInput}`); }
  else warnings.push('未找到提示词输入节点');

  // 比例 / 画质（ResolutionSelector）
  const rs = nodes.find(([, n]) => cls(n) === 'resolutionselector' || cls(n).includes('resolutionselector'));
  if (rs) {
    const [id, n] = rs; const ins = n.inputs || {};
    if ('aspect_ratio' in ins) mapping.aspect = { node: id, input: 'aspect_ratio' };
    if ('megapixels' in ins) mapping.megapixels = { node: id, input: 'megapixels', default: Number(ins.megapixels) || (outputKind === 'video' ? 1.5 : 3) };
    notes.push(`比例/画质 → 节点 ${id}`);
  } else warnings.push('未找到 ResolutionSelector（比例/画质）节点');

  // 种子
  for (const [id, n] of nodes) { const ins = n.inputs || {}; if (!mapping.seed && 'seed' in ins) { mapping.seed = { node: id, input: 'seed' }; notes.push(`种子 → 节点 ${id}`); break; } }

  // 时长（视频）：标题含时长/秒 且 inputs.value；否则参考节点 length
  if (outputKind === 'video') {
    for (const [id, n] of nodes) { const ins = n.inputs || {}; if (/时长|duration|秒|length/i.test(title(n)) && 'value' in ins) { mapping.duration = { node: id, input: 'value', min: 1, max: 30 }; notes.push(`时长 → 节点 ${id}`); break; } }
    if (!mapping.duration) for (const [id, n] of nodes) { const ins = n.inputs || {}; if (/referencetovideo/i.test(cls(n)) && 'length' in ins) { mapping.duration = { node: id, input: 'length', min: 1, max: 30 }; notes.push(`时长 → 节点 ${id}.length`); break; } }
    if (!mapping.duration) warnings.push('未找到视频时长字段（可手填）');
  }

  // 参考节点与图片槽位
  const ref = nodes.find(([, n]) => /referencetovideo/.test(cls(n)));
  const loads = nodes.filter(([, n]) => cls(n) === 'loadimage').map(([id]) => id);
  if (outputKind === 'video') {
    if (ref) { mapping.refNode = ref[0]; notes.push(`参考节点 → ${ref[0]}`); }
    if (loads.length) mapping.imageSlots = loads;
    mapping.maxImages = ref ? 9 : loads.length;
    mapping.maxVideos = ref ? 3 : 0;
    mapping.maxAudios = ref ? 3 : 0;
  } else {
    mapping.imageSlots = [];
    mapping.maxImages = 0;
  }

  return { outputNode, outputKind: outputKind || 'image', mapping, notes, warnings };
}
