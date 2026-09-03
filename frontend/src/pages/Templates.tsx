import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { templatesApi } from '../api/templates';
import { ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePageTitle } from '../hooks/usePageTitle';

export default function Templates() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  usePageTitle(t('templates.title'));
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: templatesApi.list });
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => templatesApi.create(t('templates.untitled')),
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      navigate(`/templates/${template.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('templates.createFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => templatesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('templates.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('templates.title')}</h1>
        <button onClick={() => createMutation.mutate()} disabled={createMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {createMutation.isPending ? t('templates.creating') : t('templates.create')}
        </button>
      </div>
      <p className="text-sm text-gray-500">{t('templates.subtitle')}</p>

      {templatesQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('templates.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {templatesQuery.data?.map((template) => (
            <li key={template.id} className="flex items-center justify-between p-3">
              <button onClick={() => navigate(`/templates/${template.id}`)} className="font-medium underline">{template.name}</button>
              <button onClick={() => setConfirmingId(template.id)} className="text-sm text-red-600">{t('templates.delete')}</button>
            </li>
          ))}
          {templatesQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('templates.empty')}</li>}
        </ul>
      )}

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('templates.deleteConfirmTitle')}
        description={t('templates.deleteConfirmDescription')}
        confirmLabel={t('templates.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
