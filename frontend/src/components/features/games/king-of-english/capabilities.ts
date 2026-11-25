export type KingCapability = {
  playEnabled: boolean;
  contentChannel: string;
  attribution?: string;
  modeAvailability?: Record<string, boolean>;
  conquestSizes?: { size: number; ms: number }[];
  snapshot?: { snapshotId?: string; activationStatus: string };
};

export function modeAvailable(capability: KingCapability | null, mode: string): boolean {
  const active = capability?.snapshot?.activationStatus;
  const channelReady = capability?.contentChannel !== 'PRODUCTION' || active === 'PRODUCTION_ACTIVE' || active === 'LOCAL_TEST_ACTIVE';
  return capability?.playEnabled === true && channelReady && capability.modeAvailability?.[mode] === true;
}

export function availabilityMessage(capability: KingCapability | null, playable: boolean, vi: boolean): string {
  if (!capability) return vi ? 'Chưa thể kiểm tra nội dung trò chơi. Vui lòng tải lại trang.' : 'Game availability could not be checked. Please reload.';
  if (!capability.playEnabled) return vi ? 'Nội dung trò chơi chưa được kích hoạt.' : 'Game content has not been activated.';
  if (!playable) return vi ? 'Chế độ này chưa có nội dung khả dụng.' : 'This mode has no available content.';
  if (capability.snapshot?.activationStatus === 'LOCAL_TEST_ACTIVE') return vi ? 'Nội dung đã kích hoạt cho kiểm thử cục bộ.' : 'Content is active for local testing.';
  if (capability.snapshot?.activationStatus === 'PRODUCTION_ACTIVE') return vi ? 'Sẵn sàng chơi.' : 'Ready to play.';
  return vi ? 'Bản chơi thử: nội dung có nguồn, chờ chủ sở hữu duyệt.' : 'Review preview: source-backed content awaits owner review.';
}
