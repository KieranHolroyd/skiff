from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response.json({"greeting": self.env.GREETING, "url": request.url})

    async def scheduled(self, controller, env=None, ctx=None):
        print(f"cron {controller.cron} at {controller.scheduledTime}")
