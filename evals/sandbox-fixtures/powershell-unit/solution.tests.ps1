. $PSScriptRoot\solution.ps1
if ((Clamp -Value -1 -Minimum 0 -Maximum 4) -ne 0) { throw "lower bound failed" }
if ((Clamp -Value 7 -Minimum 0 -Maximum 4) -ne 4) { throw "upper bound failed" }
if ((Clamp -Value 2 -Minimum 0 -Maximum 4) -ne 2) { throw "identity failed" }
