import type { AdminConnection } from '@iobroker/gui-components';

import type {
    EventsAnswer,
    EventsRequest,
    SnapshotAnswer,
    SnapshotRequest,
    TimelineAnswer,
    TimelineRequest,
} from '../../src/lib/walk-types';

export type {
    EventsAnswer,
    JournalEntry,
    SnapshotAnswer,
    SnapshotEntry,
    SourceKindName,
    TimelineAnswer,
} from '../../src/lib/walk-types';

/** A stopped instance never answers */
const TIMEOUT = 20_000;

/** The `sendTo` commands of the recorder for the time machine */
export class RecorderApi {
    public constructor(
        private readonly socket: AdminConnection,
        public readonly instanceId: string,
    ) {}

    public snapshot(request: SnapshotRequest): Promise<SnapshotAnswer> {
        return this.call<SnapshotAnswer>('getSnapshot', request);
    }

    public events(request: EventsRequest): Promise<EventsAnswer> {
        return this.call<EventsAnswer>('getEvents', request);
    }

    public timeline(request: TimelineRequest): Promise<TimelineAnswer> {
        return this.call<TimelineAnswer>('getTimeline', request);
    }

    /** True if the instance runs */
    public async isAlive(): Promise<boolean> {
        const state = await this.socket.getState(`system.adapter.${this.instanceId}.alive`);
        return !!state?.val;
    }

    private async call<T extends { error?: string }>(command: string, data: unknown): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT);
        });
        try {
            const answer = await Promise.race([this.socket.sendTo<T>(this.instanceId, command, data), timeout]);
            if (!answer) {
                throw new Error('no answer');
            }
            if (answer.error) {
                throw new Error(answer.error);
            }
            return answer;
        } finally {
            clearTimeout(timer);
        }
    }
}
