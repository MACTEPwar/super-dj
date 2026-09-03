import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
}

// Shared confirmation step for destructive actions (deleting a track/playlist/destination,
// stopping-and-removing a stream session) — built on the same Dialog primitive Drawer already
// uses, rather than the browser's native confirm() (unstyled, blocks the whole tab, and can't be
// tested the same way as the rest of the UI).
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, isPending }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-gray-600">{description}</Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="rounded border px-4 py-2 text-sm">{t('confirmDialog.cancel')}</Dialog.Close>
            <button
              onClick={onConfirm}
              disabled={isPending}
              className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {isPending ? t('confirmDialog.working') : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
