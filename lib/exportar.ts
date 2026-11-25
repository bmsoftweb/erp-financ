/**
 * Exportação das listas: Excel (CSV com ";" e BOM UTF-8, que o Excel abre com acento e número em pt-BR) e PDF (a tabela
 * numa janela própria com o diálogo de impressão do navegador; lá se escolhe "Salvar como PDF").
 */

export interface ColunaExport { label: string; texto: (linha: any) => string; alinhar?: 'texto' | 'numero' | 'centro' }

export function exportarExcel(nome: string, colunas: ColunaExport[], linhas: any[]) {
  const celula = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = '﻿' + [colunas.map((c) => celula(c.label)), ...linhas.map((l) => colunas.map((c) => celula(c.texto(l))))].map((r) => r.join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${nome.replace(/[^\w-]+/g, '_')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const html = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function exportarPdf(titulo: string, colunas: ColunaExport[], linhas: any[]) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('O navegador bloqueou a janela de impressão: libere pop-ups para este endereço.');
  const alinhar = (c: ColunaExport) => (c.alinhar === 'numero' ? 'right' : c.alinhar === 'centro' ? 'center' : 'left');
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${html(titulo)}</title><style>
    body{font:11px system-ui,sans-serif;margin:16px;color:#1c1917} h1{font-size:15px;margin:0 0 2px} p{margin:0 0 10px;color:#78716c}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #d6d3d1;padding:3px 5px} th{background:#f5f5f4}
    @page{size:landscape;margin:10mm}</style></head><body>
    <h1>${html(titulo)}</h1><p>${new Date().toLocaleString('pt-BR')} · ${linhas.length} linha(s)</p>
    <table><thead><tr>${colunas.map((c) => `<th style="text-align:${alinhar(c)}">${html(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map((l) => `<tr>${colunas.map((c) => `<td style="text-align:${alinhar(c)}">${html(c.texto(l))}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <script>window.onload=()=>{window.print()}</script></body></html>`);
  w.document.close();
}
