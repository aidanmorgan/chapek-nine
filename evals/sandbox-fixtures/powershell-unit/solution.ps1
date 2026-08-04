function Clamp([int]$Value, [int]$Minimum, [int]$Maximum) {
    [Math]::Min($Maximum, [Math]::Max($Minimum, $Value))
}
