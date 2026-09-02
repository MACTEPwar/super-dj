import { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}

// Slide-out panel used for every add/edit form in the app (uploading a track, creating a
// playlist, connecting a destination, starting a multi-destination stream) instead of each
// page inlining its own form. Built on the same Radix Dialog primitive AddDestinationModal
// already used for its centered modal — focus trap, Escape-to-close, and overlay-click-to-close
// come for free, only the positioning/sizing differs.
export function Drawer({ open, onOpenChange, title, children }: DrawerProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-xl">
          <div className="flex items-center justify-between border-b p-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label={t('drawer.close')}>✕</Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
