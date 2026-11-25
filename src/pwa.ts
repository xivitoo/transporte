import { registerSW } from 'virtual:pwa-register';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function initServiceWorker() {
  registerSW({
    immediate: true,
    onOfflineReady() {
      // Cache lista para uso sin conexión
    },
  });
}

export function initPWAInstall(installBtn: HTMLButtonElement, iosModal: HTMLElement, closeIosBtn: HTMLButtonElement) {
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;

  if (isStandalone) {
    installBtn.classList.add('hidden');
    return;
  }

  const ua = window.navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);

  const updateVisibility = () => {
    if (deferredPrompt) {
      installBtn.classList.remove('hidden');
      installBtn.textContent = 'Instalar app';
    } else if (isIOS) {
      installBtn.classList.remove('hidden');
      installBtn.textContent = 'Instalar en iOS';
    } else {
      installBtn.classList.add('hidden');
    }
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    updateVisibility();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.classList.add('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        installBtn.classList.add('hidden');
      }
    } else if (isIOS) {
      iosModal.classList.remove('hidden');
    }
  });

  closeIosBtn.addEventListener('click', () => {
    iosModal.classList.add('hidden');
  });

  iosModal.addEventListener('click', (e) => {
    if (e.target === iosModal) {
      iosModal.classList.add('hidden');
    }
  });

  updateVisibility();
}

export function initOnlineStatus(bannerEl: HTMLElement) {
  const sync = () => {
    if (navigator.onLine) {
      bannerEl.classList.add('hidden');
    } else {
      bannerEl.classList.remove('hidden');
    }
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}
