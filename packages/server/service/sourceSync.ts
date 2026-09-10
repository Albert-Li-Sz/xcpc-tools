export class SourceSync {
    private teamContest = '';
    private teamSuccessAt = 0;
    private initializedContest = '';

    async run(fetcher: any, now = Date.now()) {
        await fetcher.contestInfo();
        const identity = JSON.stringify([fetcher.contest.domainId || '', String(fetcher.contest.id)]);
        if (this.teamContest !== identity || now - this.teamSuccessAt >= 5 * 60_000) {
            await fetcher.teamInfo();
            this.teamContest = identity;
            this.teamSuccessAt = now;
        }
        const first = this.initializedContest !== identity;
        await fetcher.balloonInfo(first);
        await fetcher.printInfo(first);
        this.initializedContest = identity;
    }
}
