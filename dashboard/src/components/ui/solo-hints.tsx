'use client';

import { useState, useEffect } from 'react';
import { Lightbulb, X } from 'lucide-react';

const HINTS = [
    {
        text: 'Grov is even better when your team shares memories together',
        link: '/team',
        linkText: 'Invite teammates',
    },
    {
        text: 'Join our Discord to talk directly with the founders',
        link: 'https://discord.gg/Pz5P6Havr7',
        linkText: 'Join Discord',
        external: true,
    },
    {
        text: 'Team memories help onboard new developers faster',
        link: '/team',
        linkText: 'Grow your team',
    },
    {
        text: 'See how your teammates solve similar problems',
        link: '/team',
        linkText: 'Add teammates',
    },
];

const STORAGE_KEY = 'grov-hints-dismissed';
const ROTATION_INTERVAL = 7 * 60 * 1000; // 7 minutes

export function SoloHints() {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isVisible, setIsVisible] = useState(true);
    const [isFading, setIsFading] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const dismissed = localStorage.getItem(STORAGE_KEY);
        if (dismissed === 'true') {
            setIsVisible(false);
        }
    }, []);

    useEffect(() => {
        if (!isVisible) return;

        const interval = setInterval(() => {
            setIsFading(true);
            setTimeout(() => {
                setCurrentIndex((prev) => (prev + 1) % HINTS.length);
                setIsFading(false);
            }, 200);
        }, ROTATION_INTERVAL);

        return () => clearInterval(interval);
    }, [isVisible]);

    const handleDismiss = () => {
        localStorage.setItem(STORAGE_KEY, 'true');
        setIsVisible(false);
    };

    // Don't render on server or if dismissed
    if (!mounted || !isVisible) return null;

    const hint = HINTS[currentIndex];

    return (
        <div className="flex items-center gap-2 rounded-lg bg-bark/50 border border-border/50 px-3 py-2 text-xs text-text-calm transition-all">
            <Lightbulb className="h-3.5 w-3.5 text-leaf shrink-0" />
            <span
                className={`transition-opacity duration-200 ${isFading ? 'opacity-0' : 'opacity-100'}`}
            >
                <span className="text-text-quiet">Hint:</span>{' '}
                <span className="text-text-calm">{hint.text}</span>
                {hint.link && (
                    <>
                        {' · '}
                        <a
                            href={hint.link}
                            target={hint.external ? '_blank' : undefined}
                            rel={hint.external ? 'noopener noreferrer' : undefined}
                            className="text-leaf hover:text-bloom transition-colors"
                        >
                            {hint.linkText}
                        </a>
                    </>
                )}
            </span>
            <button
                onClick={handleDismiss}
                className="ml-auto shrink-0 p-0.5 rounded hover:bg-moss transition-colors text-text-quiet hover:text-text-calm"
                aria-label="Dismiss hints"
            >
                <X className="h-3 w-3" />
            </button>
        </div>
    );
}
