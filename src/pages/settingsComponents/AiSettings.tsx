import { useState } from 'react';
import { Bot as IconBot, Eye as IconEye, EyeOff as IconEyeOff, ExternalLink as IconLink } from 'lucide-react';
import { useConfigStore } from '../../store/config';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { SectionTitle } from './shared';

/** AI 助手设置：OpenAI 兼容端点配置（base_url / api_key / model） */
export function AiSettings() {
	const { t } = useTranslation();
	const config = useConfigStore((state) => state.config);
	const updateConfig = useConfigStore((state) => state.updateConfig);
	const [showKey, setShowKey] = useState(false);

	if (!config) return null;
	const ai = config.ai ?? { base_url: '', api_key: '', model: '', context_max_chars: 12000 };

	const updateAi = (updates: Partial<typeof ai>) => {
		updateConfig({ ...config, ai: { ...ai, ...updates } });
	};

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
				<div>
					<Label>{t('ai.baseUrl')}</Label>
					<Input
						value={ai.base_url}
						onChange={(e) => updateAi({ base_url: e.target.value })}
						placeholder="https://api.deepseek.com/v1"
					/>
					<p className="mt-1 text-xs text-muted-foreground">
						{t('ai.baseUrlHint')}
					</p>
				</div>
				<div>
					<Label>{t('ai.model')}</Label>
					<Input
						value={ai.model}
						onChange={(e) => updateAi({ model: e.target.value })}
						placeholder="deepseek-chat"
					/>
				</div>
				<div>
					<Label>{t('ai.apiKey')}</Label>
					<div className="flex gap-2">
						<Input
							type={showKey ? 'text' : 'password'}
							value={ai.api_key}
							onChange={(e) => updateAi({ api_key: e.target.value })}
							placeholder="sk-..."
						/>
						<Button variant="outline" size="icon" onClick={() => setShowKey((v) => !v)}>
							{showKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
						</Button>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">{t('ai.apiKeyHint')}</p>
				</div>
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
		</div>
	);
}
