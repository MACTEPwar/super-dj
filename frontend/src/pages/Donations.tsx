import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { interactionRulesApi, InteractionRule, InteractionRuleInput } from '../api/interactionRules';
import { ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { usePageTitle } from '../hooks/usePageTitle';

const ACTION_TYPE_LABELS: Record<InteractionRule['actionType'], string> = {
  songRequest: 'donations.actionSongRequest',
};

interface RuleFormState {
  minAmount: string;
  commandKeyword: string;
  enabled: boolean;
}

const EMPTY_FORM: RuleFormState = { minAmount: '', commandKeyword: 'song', enabled: true };

function RuleForm({ initial, onSubmit, isPending, error }: {
  initial: RuleFormState;
  onSubmit: (input: InteractionRuleInput) => void;
  isPending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(form.minAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setValidationError(t('donations.form.invalidAmount'));
      return;
    }
    if (!/^[a-zA-Z0-9]{1,20}$/.test(form.commandKeyword)) {
      setValidationError(t('donations.form.invalidKeyword'));
      return;
    }
    setValidationError(null);
    onSubmit({ actionType: 'songRequest', enabled: form.enabled, minAmount: amount, commandKeyword: form.commandKeyword });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium">{t('donations.form.actionType')}</label>
        <select disabled className="mt-1 w-full rounded border p-2">
          <option>{t('donations.actionSongRequest')}</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium">{t('donations.form.minAmount')}</label>
        <input
          type="number"
          value={form.minAmount}
          onChange={(e) => setForm({ ...form, minAmount: e.target.value })}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label className="block text-sm font-medium">{t('donations.form.commandKeyword')}</label>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-gray-500">!</span>
          <input
            type="text"
            value={form.commandKeyword}
            onChange={(e) => setForm({ ...form, commandKeyword: e.target.value })}
            className="w-full rounded border p-2"
          />
        </div>
        <p className="mt-1 text-xs text-gray-500">{t('donations.form.commandKeywordHint')}</p>
      </div>
      <p className="rounded bg-gray-50 p-3 text-sm text-gray-600">
        {t('donations.form.instructionPreview', { keyword: form.commandKeyword || '…' })}
      </p>
      {(validationError || error) && <p className="text-sm text-red-600">{validationError ?? error}</p>}
      <button type="submit" disabled={isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {isPending ? t('donations.form.saving') : t('donations.form.save')}
      </button>
    </form>
  );
}

export default function Donations() {
  const { t } = useTranslation();
  usePageTitle(t('donations.title'));
  const queryClient = useQueryClient();
  const rulesQuery = useQuery({ queryKey: ['interaction-rules'], queryFn: interactionRulesApi.list });
  const [drawerState, setDrawerState] = useState<{ mode: 'create' } | { mode: 'edit'; rule: InteractionRule } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: InteractionRuleInput) => interactionRulesApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setDrawerState(null);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : t('donations.form.saveFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: InteractionRuleInput }) => interactionRulesApi.update(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setDrawerState(null);
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : t('donations.form.saveFailed'));
      toast.error(err instanceof ApiError ? err.message : t('donations.form.saveFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => interactionRulesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['interaction-rules'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('donations.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('donations.title')}</h1>
        <button onClick={() => { setFormError(null); setDrawerState({ mode: 'create' }); }} className="rounded bg-black px-4 py-2 text-white">
          {t('donations.add')}
        </button>
      </div>
      <p className="text-sm text-gray-500">{t('donations.subtitle')}</p>

      {rulesQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('donations.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rulesQuery.data?.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between p-3">
              <div>
                <div className="font-medium">{t(ACTION_TYPE_LABELS[rule.actionType])}</div>
                <div className="text-sm text-gray-500">
                  {t('donations.triggerSummary', { amount: rule.minAmount, keyword: rule.commandKeyword })}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => updateMutation.mutate({ id: rule.id, input: { actionType: rule.actionType, enabled: !rule.enabled, minAmount: rule.minAmount, commandKeyword: rule.commandKeyword } })}
                />
                <button onClick={() => { setFormError(null); setDrawerState({ mode: 'edit', rule }); }} className="text-sm underline">{t('donations.edit')}</button>
                <button onClick={() => setConfirmingId(rule.id)} className="text-sm text-red-600">{t('donations.delete')}</button>
              </div>
            </li>
          ))}
          {rulesQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('donations.empty')}</li>}
        </ul>
      )}

      <Drawer
        open={drawerState !== null}
        onOpenChange={(open) => !open && setDrawerState(null)}
        title={drawerState?.mode === 'edit' ? t('donations.form.editTitle') : t('donations.form.createTitle')}
      >
        {drawerState && (
          <RuleForm
            initial={drawerState.mode === 'edit'
              ? { minAmount: String(drawerState.rule.minAmount), commandKeyword: drawerState.rule.commandKeyword, enabled: drawerState.rule.enabled }
              : EMPTY_FORM}
            isPending={createMutation.isPending || updateMutation.isPending}
            error={formError}
            onSubmit={(input) => (drawerState.mode === 'edit'
              ? updateMutation.mutate({ id: drawerState.rule.id, input })
              : createMutation.mutate(input))}
          />
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('donations.deleteConfirmTitle')}
        description={t('donations.deleteConfirmDescription')}
        confirmLabel={t('donations.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
