import React, { useCallback, useEffect, useState } from 'react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { api } from '@/lib/api';

interface Perfil { id: number; nome: string; usuarios: number; chaves: string[] }
interface Dados { admin: boolean; itens: { chave: string; nome: string }[]; perfis: Perfil[] }

/**
 * Permissões do financeiro por perfil (os perfis são criados no Master). Administrador e super podem tudo e não
 * aparecem aqui; cada toggle grava na hora.
 */
export default function PermissoesPage() {
  const [d, setD] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      setD(await api<Dados>('/api/financ/permissoes'));
    } catch (e: any) {
      setErro(e.message);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const alternar = async (p: Perfil, chave: string, v: boolean) => {
    const chaves = v ? [...p.chaves, chave] : p.chaves.filter((c) => c !== chave);
    setD((x) => x && { ...x, perfis: x.perfis.map((y) => (y.id === p.id ? { ...y, chaves } : y)) });
    try {
      await api(`/api/financ/permissoes/${p.id}`, 'PUT', { chaves });
      setOk(`Perfil ${p.nome} atualizado.`);
    } catch (e: any) {
      setErro(e.message);
      await carregar();
    }
  };

  if (!d) return erro ? <AvisoErro mensagem={erro} onFechar={() => setErro('')} /> : null;
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {!d.admin && <p className="m-3 text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">Somente leitura: só administradores alteram as permissões.</p>}
      <ListaCrm
        className="flex-1"
        id="permissoes"
        linhas={d.perfis}
        chave={(r) => r.id}
        vazio="Nenhum perfil. Crie os perfis no Master (Usuários › Perfis) e volte aqui."
        colunas={[
          { key: 'nome', label: 'Perfil', largura: 200 },
          { key: 'usuarios', label: 'Usuários', alinhar: 'numero', largura: 80 },
          ...d.itens.map((i) => ({
            key: i.chave,
            label: i.nome,
            alinhar: 'centro' as const,
            largura: 150,
            render: (r: Perfil) => <Toggle size="sm" disabled={!d.admin} checked={r.chaves.includes(i.chave)} onChange={(v) => void alternar(r, i.chave, v)} />,
          })),
        ]}
      />
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}
