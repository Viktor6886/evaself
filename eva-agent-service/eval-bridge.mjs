import { executeCanonical, executeTelegram, weakenedDependencies } from "./eval-tooling/harness.mjs";
const request=JSON.parse(process.argv[2]??"{}");
process.stdout.write(JSON.stringify(request.target==="telegram"?await executeTelegram(request):await executeCanonical(request,request.mutation?weakenedDependencies(request.mutation):undefined)));
