import { useEffect, useState } from 'react';
import {
  Bot as IconBot,
  Check as IconCheck,
  Eye as IconEye,
  EyeOff as IconEyeOff,
  ExternalLink as IconLink,
  Plus as IconPlus,
  Trash2 as IconTrash,
} from 'lucide-react';
import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { SectionTitle } from './shared';
import type { AiProfile, AiProtocol } from '../../types/config';
import { cn } from '../../lib/utils';

/** 各协议的地址与模型占位提示 */
const PROTOCOL_HINTS: Record<AiProtocol, { url: string; model: string }> = {
  openai: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  anthropic: { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
};

/** AI 助手设置：多提供商档案管理（协议 + 地址 + 模型 + Key），点选卡片头部激活 */
export function AiSettings() {
	const { t } = useTranslation();
	const config = useConfigStore((state) => state.config);
	const updateConfig = useConfigStore((state) => state.updateConfig);

	if (!config) return null;
	const ai = config.ai;

	const updateAi = (updates: Partial<typeof ai>) => {
		updateConfig({ ...config, ai: { ...ai, ...updates } });
	};

	// 旧配置迁移：老 config.toml 只有单档案字段，首次进入设置页自动转为第一个档案
	useEffect(() => {
		if (!config?.ai) return;
		const legacy = config.ai;
		if ((!legacy.profiles || legacy.profiles.length === 0) && legacy.base_url.trim()) {
			const profile: AiProfile = {
				id: `profile-${Date.now()}`,
				name: 'Default',
				protocol: 'openai',
				base_url: legacy.base_url,
				api_key: legacy.api_key,
				model: legacy.model,
			};
			updateConfig({ ...config, ai: { ...legacy, profiles: [profile], active_profile: profile.id } });
		}
		// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在进入页面时尝试一次迁移
	}, []);

	const profiles = ai.profiles ?? [];

	const addProfile = () => {
		const profile: AiProfile = {
			id: `profile-${Date.now()}`,
			name: t('ai.defaultProfileName'),
			protocol: 'openai',
			base_url: '',
			api_key: '',
			model: '',
		};
		// 首个档案自动激活，后续添加不抢焦点
		updateAi({
			profiles: [...profiles, profile],
			active_profile: profiles.length === 0 ? profile.id : ai.active_profile,
		});
	};

	const removeProfile = (id: string) => {
		const remaining = profiles.filter((p) => p.id !== id);
		updateAi({
			profiles: remaining,
			active_profile: ai.active_profile === id ? (remaining[0]?.id ?? '') : ai.active_profile,
		});
	};

	const updateProfile = (id: string, updates: Partial<AiProfile>) => {
		updateAi({ profiles: profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)) });
	};

	const isActive = (p: AiProfile) => ai.active_profile === p.id || (!ai.active_profile && profiles[0]?.id === p.id);

	return (
		<div className="space-y-4">
			<SectionTitle>
				<span className="flex items-center gap-2">
					<IconBot size={16} />
					{t('ai.settingsTitle')}
				</span>
			</SectionTitle>
			<p className="-mt-2 mb-4 text-xs text-muted-foreground">{t('ai.settingsDesc')}</p>

			<div className="max-w-xl space-y-3">
				{profiles.length === 0 && (
					<p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
						{t('ai.noProfiles')}
					</p>
				)}

				{profiles.map((profile) => (
					<div
						key={profile.id}
						className={cn(
							'space-y-3 rounded-lg border p-3',
							isActive(profile) ? 'border-primary/60' : 'border-border',
						)}
					>
						{/* 头部：激活选择 + 名称 + 协议 + 删除 */}
						<div className="flex items-center gap-2">
							<button
								type="button"
								className="flex shrink-0 items-center gap-1.5"
								onClick={() => updateAi({ active_profile: profile.id })}
								title={t('ai.setActiveProfile')}
							>
								<span
									className={cn(
										'flex size-4 items-center justify-center rounded-full border',
										isActive(profile) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
									)}
								>
									{isActive(profile) && <IconCheck size={10} strokeWidth={3} />}
								</span>
								<span className={cn('text-xs', isActive(profile) ? 'font-medium text-foreground' : 'text-muted-foreground')}>
									{isActive(profile) ? t('ai.activeProfile') : t('ai.setActiveProfile')}
								</span>
							</button>
							<Input
								value={profile.name}
								onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
								placeholder={t('ai.profileName')}
								className="h-7 flex-1 border-transparent bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
							/>
							<Select
								value={profile.protocol}
								onValueChange={(v) => updateProfile(profile.id, { protocol: v as AiProtocol })}
							>
								<SelectTrigger size="sm" className="h-7 w-[130px] shrink-0 text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="openai">{t('ai.protocolOpenai')}</SelectItem>
									<SelectItem value="anthropic">{t('ai.protocolAnthropic')}</SelectItem>
								</SelectContent>
							</Select>
							{profiles.length > 1 && (
								<Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => removeProfile(profile.id)}>
									<IconTrash size={13} />
								</Button>
							)}
						</div>

						{/* 编辑体：地址 / 模型 / Key（按协议给占位提示） */}
						<div className="space-y-2">
							<div>
								<Label className="text-xs">{t('ai.baseUrl')}</Label>
								<Input
									value={profile.base_url}
									onChange={(e) => updateProfile(profile.id, { base_url: e.target.value })}
									placeholder={PROTOCOL_HINTS[profile.protocol]?.url ?? PROTOCOL_HINTS.openai.url}
									className="h-8 text-xs"
								/>
								<p className="mt-1 text-xs text-muted-foreground">
									{profile.protocol === 'anthropic' ? t('ai.baseUrlHintAnthropic') : t('ai.baseUrlHint')}
								</p>
							</div>
							<div>
								<Label className="text-xs">{t('ai.model')}</Label>
								<Input
									value={profile.model}
									onChange={(e) => updateProfile(profile.id, { model: e.target.value })}
									placeholder={PROTOCOL_HINTS[profile.protocol]?.model ?? PROTOCOL_HINTS.openai.model}
									className="h-8 text-xs"
								/>
							</div>
							<ProfileKeyInput
								value={profile.api_key}
								onChange={(v) => updateProfile(profile.id, { api_key: v })}
							/>
						</div>
					</div>
				))}

				<div className="flex items-center justify-between">
					<Button variant="outline" size="sm" className="h-7 text-xs" onClick={addProfile}>
						<IconPlus size={12} />
						{t('ai.addProfile')}
					</Button>
					<a
						href="https://platform.openai.com/docs/api-reference/chat"
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<IconLink size={12} />
						OpenAI Chat API
					</a>
				</div>
				<p className="text-xs text-muted-foreground">{t('ai.profilesHint')}</p>
			</div>
		</div>
	);
}

/** 档案 API Key 输入（独立组件持有显隐状态，切换档案不串显示状态） */
function ProfileKeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
	const { t } = useTranslation();
	const [showKey, setShowKey] = useState(false);
	return (
		<div>
			<Label className="text-xs">{t('ai.apiKey')}</Label>
			<div className="flex gap-2">
				<Input
					type={showKey ? 'text' : 'password'}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder="sk-..."
					className="h-8 text-xs"
				/>
				<Button variant="outline" size="icon" className="size-8" onClick={() => setShowKey((v) => !v)}>
					{showKey ? <IconEyeOff size={13} /> : <IconEye size={13} />}
				</Button>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">{t('ai.apiKeyHint')}</p>
		</div>
	);
}
