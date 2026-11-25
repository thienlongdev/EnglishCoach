'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  User,
  Mail,
  Phone,
  MapPin,
  Lock,
  Eye,
  EyeOff,
  Camera,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Shield,
  Calendar,
  Pencil,
  IdCard,
  UserRound,
  Save,
  ChevronRight,
} from 'lucide-react';
import { userProfileApi } from '@/services/userProfileApi';
import { logout } from '@/services/logout';
import { useLanguage } from '@/context/LanguageContext';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile';
import { useCurrentUserAvatar, revokeCurrentAvatarObjectUrl } from '@/hooks/useCurrentUserAvatar';
import { UserAvatar } from '@/components/common/UserAvatar';
import { useAvatarFrames } from '@/hooks/useAvatarFrames';
import { TIER_DISPLAY_NAMES, AvatarFrameDto } from '@/types/avatarFrame';
import { Award } from 'lucide-react';
import { ActiveSessionsCard } from '@/components/features/profile/ActiveSessionsCard';
import { FrameCabinet, frameAccent } from '@/components/features/profile/FrameCabinet';
import { AvatarFrameWardrobeModal } from '@/components/features/avatar-frame/AvatarFrameWardrobeModal';
import { AvatarFrameUnlockCeremony } from '@/components/features/avatar-frame/AvatarFrameUnlockCeremony';
import { pointerLight } from '@/lib/ui/pointerLight';
import s from '@/components/features/profile/profileGlass.module.css';

/**
 * Hồ sơ cá nhân — "Echo Glass · Identity": the learner's identity stage (avatar on the equipped frame's light), the frame
 * cabinet, personal and account details, signed-in devices and sign-in security. Presentation only: every value is the
 * server's profile / frame catalogue / session list, every action is the existing handler below.
 */
export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { locale } = useLanguage();
  const t = (vi: string, en: string) => (locale === 'vi' ? vi : en);

  // Shared profile data from canonical SWR cache
  const {
    profile,
    isLoading: isProfileLoading,
    error: profileError,
    mutateProfile,
  } = useCurrentUserProfile();
  const { hasAvatar, avatarUrl } = useCurrentUserAvatar();

  // Avatar frames state
  const {
    catalogue: frameCatalogue,
    equippedFrame,
    equip: equipFrame,
    unequip: unequipFrame,
    isLoading: isFramesLoading,
    reconcile: reconcileFrames,
  } = useAvatarFrames();
  const [showFrameModal, setShowFrameModal] = useState(false);
  const [frameActionLoading, setFrameActionLoading] = useState(false);
  const [frameActionMsg, setFrameActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [ceremonyFrame, setCeremonyFrame] = useState<AvatarFrameDto | null>(null);

  // Auto-reconcile on session ready and trigger unlock ceremony if high-tier frame unlocked
  useEffect(() => {
    if (session?.user) {
      reconcileFrames().then((newlyUnlocked) => {
        if (newlyUnlocked && newlyUnlocked.length > 0) {
          setCeremonyFrame(newlyUnlocked[0]);
        }
      }).catch(() => {});
    }
  }, [session?.user]);

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [province, setProvince] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSuccessMsg, setProfileSuccessMsg] = useState<string | null>(null);
  const [profileErrorMsg, setProfileErrorMsg] = useState<string | null>(null);

  // Avatar upload/delete states
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password states
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordSuccessMsg, setPasswordSuccessMsg] = useState<string | null>(null);
  const [passwordErrorMsg, setPasswordErrorMsg] = useState<string | null>(null);

  // Auth check
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login?callbackUrl=/profile');
    }
  }, [status, router]);

  // Sync form state when profile data arrives or is updated
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || '');
      setPhone(profile.phone || '');
      // Canonical single location field: province (falling back to legacy city if province empty)
      setProvince(profile.province || profile.city || '');
      setDateOfBirth(profile.dateOfBirth || '');
    }
  }, [profile]);

  // Handle avatar upload
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/jpeg') && !file.type.startsWith('image/png')) {
      setAvatarError(t('Chỉ chấp nhận file định dạng JPEG hoặc PNG.', 'Only JPEG or PNG image files are supported.'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError(t('Kích thước ảnh không được vượt quá 2MB.', 'Image file size must not exceed 2MB.'));
      return;
    }

    try {
      setAvatarLoading(true);
      setAvatarError(null);
      const updated = await userProfileApi.uploadAvatar(file);
      await mutateProfile(updated, { revalidate: true });
    } catch (err: any) {
      console.error('Failed to upload avatar', err);
      const msg = err.response?.data?.message || t('Tải ảnh đại diện thất bại.', 'Failed to upload avatar.');
      setAvatarError(msg);
    } finally {
      setAvatarLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Handle avatar removal
  const handleRemoveAvatar = async () => {
    try {
      setAvatarLoading(true);
      setAvatarError(null);
      await userProfileApi.deleteAvatar();
      revokeCurrentAvatarObjectUrl();
      if (profile) {
        await mutateProfile(
          { ...profile, avatarPresent: false, avatarUpdatedAt: null },
          { revalidate: true }
        );
      }
    } catch (err: any) {
      console.error('Failed to delete avatar', err);
      setAvatarError(t('Xóa ảnh đại diện thất bại.', 'Failed to delete avatar.'));
    } finally {
      setAvatarLoading(false);
    }
  };

  // Handle avatar frame equip
  const handleEquip = async (slug: string) => {
    try {
      setFrameActionLoading(true);
      setFrameActionMsg(null);
      await equipFrame(slug);
      setFrameActionMsg({
        type: 'success',
        text: t('Trang bị khung thành công!', 'Avatar frame equipped successfully!'),
      });
    } catch (err: any) {
      const msg = err.response?.data?.message || t('Trang bị khung thất bại.', 'Failed to equip avatar frame.');
      setFrameActionMsg({ type: 'error', text: msg });
    } finally {
      setFrameActionLoading(false);
    }
  };

  // Handle avatar frame unequip
  const handleUnequip = async () => {
    try {
      setFrameActionLoading(true);
      setFrameActionMsg(null);
      await unequipFrame();
      setFrameActionMsg({
        type: 'success',
        text: t('Đã tháo khung đại diện.', 'Avatar frame unequipped.'),
      });
    } catch (err: any) {
      const msg = err.response?.data?.message || t('Tháo khung thất bại.', 'Failed to unequip avatar frame.');
      setFrameActionMsg({ type: 'error', text: msg });
    } finally {
      setFrameActionLoading(false);
    }
  };

  // Handle profile update
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileErrorMsg(null);
    setProfileSuccessMsg(null);

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setProfileErrorMsg(t('Tên hiển thị không được để trống.', 'Display name cannot be blank.'));
      return;
    }

    try {
      setIsSavingProfile(true);
      const updated = await userProfileApi.updateProfile({
        displayName: trimmedName,
        phone: phone.trim() || undefined,
        province: province.trim() || undefined,
        dateOfBirth: dateOfBirth ? dateOfBirth : null,
      });
      await mutateProfile(updated, { revalidate: false });
      setProfileSuccessMsg(t('Đã lưu thông tin hồ sơ thành công!', 'Profile information updated successfully!'));
      setTimeout(() => setProfileSuccessMsg(null), 4000);
    } catch (err: any) {
      console.error('Failed to update profile', err);
      const msg = err.response?.data?.message || t('Lưu hồ sơ thất bại. Vui lòng kiểm tra lại.', 'Failed to save profile.');
      setProfileErrorMsg(msg);
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Handle password change
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordErrorMsg(null);
    setPasswordSuccessMsg(null);

    if (!currentPassword) {
      setPasswordErrorMsg(t('Vui lòng nhập mật khẩu hiện tại.', 'Please enter your current password.'));
      return;
    }

    if (newPassword.length < 15) {
      setPasswordErrorMsg(t('Mật khẩu mới phải có ít nhất 15 ký tự.', 'New password must be at least 15 characters long.'));
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordErrorMsg(t('Mật khẩu xác nhận không khớp.', 'Password confirmation does not match.'));
      return;
    }

    try {
      setIsChangingPassword(true);
      await userProfileApi.changePassword({
        currentPassword,
        newPassword,
      });

      setPasswordSuccessMsg(
        t(
          'Đổi mật khẩu thành công! Tất cả phiên làm việc đã được đặt lại vì lý do an toàn. Đang chuyển hướng đăng nhập...',
          'Password changed successfully! All active sessions have been reset for security. Redirecting to login...'
        )
      );

      await logout('/login?passwordChanged=true');
    } catch (err: any) {
      console.error('Failed to change password', err);
      const msg =
        err.response?.data?.message ||
        t('Đổi mật khẩu thất bại. Vui lòng kiểm tra lại mật khẩu hiện tại.', 'Failed to change password.');
      setPasswordErrorMsg(msg);
      setIsChangingPassword(false);
    }
  };

  if (status === 'loading' || isProfileLoading) {
    return (
      <div className={s.page}>
        <div className={s.state} role="status">
          <Loader2 className="w-8 h-8 animate-spin motion-reduce:animate-none text-indigo-500" aria-hidden="true" />
          <p className="text-sm font-semibold">{t('Đang tải thông tin hồ sơ...', 'Loading profile...')}</p>
        </div>
      </div>
    );
  }

  if (profileError || !profile) {
    return (
      <div className={s.page}>
        <div className={`${s.panel} ${s.stateCard} text-center`} data-tone="gold">
          <AlertCircle className="w-10 h-10 mx-auto mb-3 text-rose-500" aria-hidden="true" />
          <h2 className={s.title}>{t('Không thể tải hồ sơ', 'Could not load profile')}</h2>
          <p className={`${s.lead} mb-4`}>
            {t('Không thể tải thông tin hồ sơ. Vui lòng thử lại.', 'Failed to load profile. Please try again.')}
          </p>
          <button type="button" onClick={() => mutateProfile()} className={s.btn}>
            {t('Thử lại', 'Try again')}
          </button>
        </div>
      </div>
    );
  }

  const joinedDate = profile.accountCreatedAt
    ? new Date(profile.accountCreatedAt).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', {
        year: 'numeric',
        month: 'long',
      })
    : null;

  const stageAccent = { '--fa': frameAccent(equippedFrame) } as React.CSSProperties;

  return (
    <div className={s.page}>
      <h1 className="sr-only">{t('Hồ sơ cá nhân', 'Personal profile')}</h1>
      <div className={s.layout}>
        <div className={s.main}>
          {/* ── Identity stage: avatar + equipped frame, name, real account facts, avatar / frame actions ── */}
          <section className={`${s.hero} ${s.enter}`} style={stageAccent} aria-label={t('Danh tính học viên', 'Learner identity')} {...pointerLight}>
            <HeroArt />
            <div className={s.heroBody}>
              <div className={s.stage}>
                <span className={s.halo} aria-hidden="true" />
                <span className={s.glowDisc} aria-hidden="true" />
                <svg className={`${s.crystal} ${s.crystalL}`} viewBox="0 0 20 48" aria-hidden="true"><polygon points="10,0 20,16 14,48 6,48 0,16" /></svg>
                <svg className={`${s.crystal} ${s.crystalR}`} viewBox="0 0 20 48" aria-hidden="true"><polygon points="10,0 20,18 13,48 7,48 0,18" /></svg>
                <span className={s.pedestal} aria-hidden="true" />
                <div className={s.avatarSpot}>
                  <UserAvatar
                    className="w-[120px] h-[120px] rounded-full"
                    textClassName="text-3xl"
                    size="xl"
                    context="profile"
                    showFrame={true}
                    frame={equippedFrame}
                    fallbackName={profile.displayName}
                    onClick={() => setShowFrameModal(true)}
                  />
                  {avatarLoading && (
                    <div className={s.avatarBusy}>
                      <Loader2 className="w-6 h-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    </div>
                  )}
                  <button
                    type="button"
                    className={s.editBadge}
                    data-guide="pf-avatar"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={avatarLoading}
                    aria-label={hasAvatar ? t('Đổi ảnh đại diện', 'Change avatar') : t('Tải ảnh đại diện lên', 'Upload avatar')}
                    title={hasAvatar ? t('Đổi ảnh', 'Change avatar') : t('Tải ảnh lên', 'Upload avatar')}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                {/* Hidden file input */}
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="image/png,image/jpeg"
                  className="hidden"
                />
              </div>

              <div className={s.identity}>
                <span className={s.kicker}>{t('Hồ sơ cá nhân', 'Personal profile')}</span>
                <h2 className={s.name}>{profile.displayName}</h2>
                <p className={s.metaLine}><Mail className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{profile.email}</span></p>
                {joinedDate && (
                  <p className={s.metaLine}>
                    <Calendar className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{t(`Tham gia từ ${joinedDate}`, `Joined ${joinedDate}`)}</span>
                  </p>
                )}

                {/* Avatar buttons & Frame status */}
                <div className={s.actions}>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={avatarLoading}
                    className={s.btnGhost}
                  >
                    <Camera className="w-4 h-4" aria-hidden="true" />
                    <span>{hasAvatar ? t('Đổi ảnh', 'Change avatar') : t('Tải ảnh lên', 'Upload avatar')}</span>
                  </button>

                  {profile.avatarPresent && (
                    <button
                      type="button"
                      onClick={handleRemoveAvatar}
                      disabled={avatarLoading}
                      className={s.btnGhost}
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                      <span>{t('Gỡ ảnh', 'Remove')}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowFrameModal(true)}
                    className={s.btnFrame}
                  >
                    <Award className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      {equippedFrame
                        ? `${t('Khung', 'Frame')}: ${equippedFrame.name} (${TIER_DISPLAY_NAMES[equippedFrame.tier]})`
                        : t('Khung danh hiệu', 'Avatar Frames')}
                    </span>
                    <ChevronRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                  </button>
                </div>

                {avatarError && <p className={s.avatarError} role="alert">{avatarError}</p>}
              </div>
            </div>
          </section>

          {/* Learning activity, streaks and proficiency live on /progress (Tiến trình học tập). */}

          {/* ── Section: Personal Information ── */}
          <section className={`${s.panel} ${s.enter2}`} data-tone="violet" aria-labelledby="profile-personal">
            <div className={s.head}>
              <span className={s.icon} data-tone="violet" aria-hidden="true"><UserRound className="h-5 w-5" /></span>
              <div className={s.headText}>
                <h3 id="profile-personal" className={s.title}>{t('Thông tin cá nhân', 'Personal Information')}</h3>
                <p className={s.lead}>{t('Cập nhật tên hiển thị và thông tin liên hệ', 'Update your display name and contact details')}</p>
              </div>
            </div>

            <form onSubmit={handleSaveProfile} className={s.form}>
              {profileSuccessMsg && (
                <div className={s.note} data-kind="ok" role="status">
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                  <span>{profileSuccessMsg}</span>
                </div>
              )}

              {profileErrorMsg && (
                <div className={s.note} data-kind="error" role="alert">
                  <AlertCircle className="w-4 h-4" aria-hidden="true" />
                  <span>{profileErrorMsg}</span>
                </div>
              )}

              <div className={s.grid2}>
                {/* Display Name */}
                <div>
                  <label htmlFor="profile-display-name" className={s.label}>
                    <span>{t('Tên hiển thị', 'Display Name')} <span className={s.req}>*</span></span>
                  </label>
                  <div className={s.field}>
                    <User className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-display-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={100}
                      required
                      placeholder={t('Nhập tên hiển thị...', 'Enter display name...')}
                      className={s.input}
                    />
                  </div>
                  <p className={s.hint}>
                    {t('Tên sẽ xuất hiện trong giao diện học tập của bạn', 'This name appears across your learning workspace')}
                  </p>
                </div>

                {/* Phone */}
                <div>
                  <label htmlFor="profile-phone" className={s.label}>{t('Số điện thoại', 'Phone Number')}</label>
                  <div className={s.field}>
                    <Phone className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      maxLength={32}
                      placeholder="+84 901 234 567"
                      className={s.input}
                    />
                  </div>
                </div>

                {/* Tỉnh/Thành */}
                <div>
                  <label htmlFor="profile-province" className={s.label}>{t('Tỉnh/Thành', 'Province / City')}</label>
                  <div className={s.field}>
                    <MapPin className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-province"
                      type="text"
                      value={province}
                      onChange={(e) => setProvince(e.target.value)}
                      maxLength={100}
                      placeholder={t('Hà Nội, TP. Hồ Chí Minh...', 'Hanoi, Ho Chi Minh...')}
                      className={s.input}
                    />
                  </div>
                </div>

                {/* Ngày sinh */}
                <div>
                  <label htmlFor="profile-dob" className={s.label}>{t('Ngày sinh', 'Date of Birth')}</label>
                  <div className={s.field}>
                    <Calendar className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-dob"
                      type="date"
                      value={dateOfBirth}
                      max={new Date().toISOString().split('T')[0]}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className={s.input}
                    />
                  </div>
                </div>
              </div>

              <div className={s.formFoot}>
                <button type="submit" disabled={isSavingProfile} className={s.btn}>
                  {isSavingProfile ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      <span>{t('Đang lưu...', 'Saving...')}</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" aria-hidden="true" />
                      <span>{t('Lưu thay đổi', 'Save changes')}</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </section>

          {/* ── Section: Account Information ── */}
          <section className={`${s.panel} ${s.enter3}`} data-tone="cyan" aria-labelledby="profile-account">
            <div className={s.head}>
              <span className={s.icon} data-tone="cyan" aria-hidden="true"><IdCard className="h-5 w-5" /></span>
              <div className={s.headText}>
                <h3 id="profile-account" className={s.title}>{t('Thông tin tài khoản', 'Account Information')}</h3>
                <p className={s.lead}>{t('Thông tin định danh và phương thức đăng nhập', 'Identity details and sign-in methods')}</p>
              </div>
            </div>

            <div className={s.grid2}>
              {/* Email */}
              <div>
                <label htmlFor="profile-email" className={s.label}>{t('Email tài khoản', 'Account Email')}</label>
                <div className={s.field}>
                  <Mail className={s.fieldIcon} aria-hidden="true" />
                  <input id="profile-email" type="text" value={profile.email} readOnly aria-readonly="true" className={`${s.input} ${s.inputPad} select-all`} />
                  <Lock className={s.lockMark} aria-hidden="true" />
                </div>
                <p className={s.hint}>{t('Email được dùng để đăng nhập và bảo mật', 'Email is used for sign-in and recovery')}</p>
              </div>

              {/* Account Name */}
              <div>
                <label htmlFor="profile-account-name" className={s.label}>{t('Họ và tên gốc', 'Original Account Name')}</label>
                <div className={s.field}>
                  <User className={s.fieldIcon} aria-hidden="true" />
                  <input id="profile-account-name" type="text" value={profile.accountName} readOnly aria-readonly="true" className={`${s.input} ${s.inputPad}`} />
                  <Lock className={s.lockMark} aria-hidden="true" />
                </div>
              </div>
            </div>
          </section>

          {/* ── Section: Signed-in devices (session list, end one / all others) ── */}
          <ActiveSessionsCard />

          {/* ── Section: Security / Change Password ── */}
          <section className={s.panel} data-tone="emerald" aria-labelledby="profile-security">
            <div className={s.head}>
              <span className={s.icon} data-tone="emerald" aria-hidden="true"><Shield className="h-5 w-5" /></span>
              <div className={s.headText}>
                <h3 id="profile-security" className={s.title}>{t('Bảo mật và Mật khẩu', 'Security and Password')}</h3>
                <p className={s.lead}>{t('Quản lý mật khẩu đăng nhập vào tài khoản', 'Manage your account login credentials')}</p>
              </div>
            </div>

            {profile.canChangePassword ? (
              <form onSubmit={handleChangePassword} className={`${s.form} ${s.pwForm}`}>
                {passwordSuccessMsg && (
                  <div className={s.note} data-kind="ok" role="status">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    <span>{passwordSuccessMsg}</span>
                  </div>
                )}

                {passwordErrorMsg && (
                  <div className={s.note} data-kind="error" role="alert">
                    <AlertCircle className="w-4 h-4" aria-hidden="true" />
                    <span>{passwordErrorMsg}</span>
                  </div>
                )}

                {/* Current Password */}
                <div>
                  <div className={s.label}>
                    <label htmlFor="profile-current-password">
                      {t('Mật khẩu hiện tại', 'Current Password')} <span className={s.req}>*</span>
                    </label>
                    <Link href="/forgot-password?from=profile" className={s.inlineLink}>
                      {t('Quên mật khẩu hiện tại?', 'Forgot current password?')}
                    </Link>
                  </div>
                  <div className={s.field}>
                    <Lock className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-current-password"
                      type={showCurrentPassword ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      placeholder={t('Nhập mật khẩu hiện tại...', 'Enter current password...')}
                      className={`${s.input} ${s.inputPad}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword((v) => !v)}
                      className={s.eye}
                      aria-label={showCurrentPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
                    >
                      {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* New Password */}
                <div>
                  <label htmlFor="profile-new-password" className={s.label}>
                    <span>{t('Mật khẩu mới', 'New Password')} <span className={s.req}>*</span></span>
                  </label>
                  <div className={s.field}>
                    <Lock className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-new-password"
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder={t('Mật khẩu mới (tối thiểu 15 ký tự)...', 'New password (min 15 characters)...')}
                      className={`${s.input} ${s.inputPad}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((v) => !v)}
                      className={s.eye}
                      aria-label={showNewPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
                    >
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className={s.hint}>
                    {t(
                      'Quy chuẩn: Tối thiểu 15 ký tự, không chứa tên người dùng email để đảm bảo an toàn.',
                      'Policy: Minimum 15 characters, must not contain email username for safety.'
                    )}
                  </p>
                </div>

                {/* Confirm New Password */}
                <div>
                  <label htmlFor="profile-confirm-password" className={s.label}>
                    <span>{t('Xác nhận mật khẩu mới', 'Confirm New Password')} <span className={s.req}>*</span></span>
                  </label>
                  <div className={s.field}>
                    <Lock className={s.fieldIcon} aria-hidden="true" />
                    <input
                      id="profile-confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder={t('Nhập lại mật khẩu mới...', 'Re-enter new password...')}
                      className={`${s.input} ${s.inputPad}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      className={s.eye}
                      aria-label={showConfirmPassword ? t('Ẩn mật khẩu', 'Hide password') : t('Hiện mật khẩu', 'Show password')}
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <button type="submit" disabled={isChangingPassword} className={s.btn}>
                    {isChangingPassword ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        <span>{t('Đang cập nhật...', 'Updating...')}</span>
                      </>
                    ) : (
                      <span>{t('Đổi mật khẩu', 'Change Password')}</span>
                    )}
                  </button>
                </div>
              </form>
            ) : (
              /* Google-only user explanatory state */
              <div className={s.provider}>
                <span className={s.providerMark} aria-hidden="true"><GoogleMark /></span>
                <div>
                  <h4 className={s.providerTitle}>{t('Bạn đang đăng nhập bằng Google', 'You are signed in with Google')}</h4>
                  <p className={s.providerText}>
                    {t(
                      'Tài khoản của bạn được bảo mật thông qua xác thực Google OAuth. Bạn không cần đặt hoặc quản lý mật khẩu riêng trên English Coach.',
                      'Your account is secured via Google OAuth authentication. You do not need a separate password on English Coach.'
                    )}
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>

        <aside className={s.aside} data-guide="pf-frames" aria-label={t('Khung danh hiệu', 'Avatar frames')}>
          <FrameCabinet
            catalogue={frameCatalogue}
            equippedFrame={equippedFrame}
            isLoading={isFramesLoading}
            avatarUrl={hasAvatar ? avatarUrl : null}
            displayName={profile.displayName}
            busy={frameActionLoading}
            message={showFrameModal ? null : frameActionMsg}
            onEquip={handleEquip}
            onUnequip={handleUnequip}
            onOpenAll={() => setShowFrameModal(true)}
          />
        </aside>
      </div>

      {/* ── Prestige Wardrobe Modal ── */}
      <AvatarFrameWardrobeModal
        isOpen={showFrameModal}
        onClose={() => {
          setShowFrameModal(false);
          setFrameActionMsg(null);
        }}
        catalogue={frameCatalogue}
        equippedFrame={equippedFrame}
        avatarUrl={hasAvatar ? avatarUrl : null}
        displayName={profile.displayName}
        onEquip={handleEquip}
        onUnequip={handleUnequip}
        isLoading={isFramesLoading}
      />

      {/* ── Unlock Ceremony Celebratory Modal ── */}
      <AvatarFrameUnlockCeremony
        frame={ceremonyFrame}
        avatarUrl={hasAvatar ? avatarUrl : null}
        displayName={profile.displayName}
        onEquip={handleEquip}
        onDismiss={() => setCeremonyFrame(null)}
      />
    </div>
  );
}

/** Night-ocean / pearl-dawn scenery behind the identity stage (decoration only). */
function HeroArt() {
  return (
    <div className={s.heroArt} aria-hidden="true">
      <svg viewBox="0 0 800 260" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="pp-crystal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e0f2fe" stopOpacity="0.95" />
            <stop offset="0.55" stopColor="#a5b4fc" stopOpacity="0.75" />
            <stop offset="1" stopColor="#7c3aed" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <g className={s.stars} fill="#e0e7ff">
          {[[60, 30, 1.2], [140, 64, 0.8], [230, 22, 1], [330, 48, 0.7], [420, 18, 1.3], [505, 58, 0.8], [590, 26, 1.1], [660, 70, 0.7], [742, 36, 1.2], [770, 96, 0.8], [470, 92, 0.6], [300, 100, 0.7]].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity={0.4 + r / 3} />
          ))}
        </g>
        <path className={s.ridgeFar} d="M0 210 L90 168 L150 186 L240 132 L320 176 L410 140 L480 170 L560 118 L640 160 L720 128 L800 150 L800 260 L0 260 Z" />
        <path className={s.ridgeRim} d="M480 170 L560 118 L640 160 L720 128 L800 150" />
        <path className={s.ridgeNear} d="M0 236 L120 206 L220 226 L330 192 L450 222 L560 196 L680 224 L800 204 L800 260 L0 260 Z" />
      </svg>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}
