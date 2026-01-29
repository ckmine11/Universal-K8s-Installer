const Skeleton = ({ className, circle = false }) => {
    return (
        <div
            className={`bg-white/5 animate-skeleton overflow-hidden relative ${circle ? 'rounded-full' : 'rounded-xl'} ${className}`}
        >
            {/* Shimmer effect Overlay */}
            <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/5 to-transparent"></div>
        </div>
    );
};

export default Skeleton;

export const CardSkeleton = () => (
    <div className="glass-card rounded-[32px] p-8 border border-white/5 flex items-center justify-between opacity-50">
        <div className="flex items-center space-x-8">
            <Skeleton className="w-16 h-16 rounded-2xl" />
            <div className="space-y-3">
                <Skeleton className="w-48 h-6" />
                <div className="flex space-x-4">
                    <Skeleton className="w-20 h-4" />
                    <Skeleton className="w-20 h-4" />
                </div>
            </div>
        </div>
        <div className="flex space-x-2">
            <Skeleton className="w-24 h-12 rounded-2xl" />
            <Skeleton className="w-32 h-12 rounded-2xl" />
        </div>
    </div>
);

export const HealthSkeleton = () => (
    <div className="space-y-6 opacity-50">
        <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map(i => (
                <div key={i} className="bg-white/5 rounded-2xl p-6 border border-white/5">
                    <Skeleton className="w-20 h-4 mb-4" />
                    <Skeleton className="w-full h-8" />
                </div>
            ))}
        </div>
        <div className="space-y-2">
            {[1, 2, 3, 4].map(i => (
                <Skeleton key={i} className="w-full h-16 rounded-2xl" />
            ))}
        </div>
    </div>
);
